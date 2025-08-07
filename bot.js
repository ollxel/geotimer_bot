// =================================================================
// 1. ИМПОРТЫ И НАЧАЛЬНАЯ НАСТРОЙКА
// =================================================================
require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const NodeGeocoder = require('node-geocoder');

// --- Переменные окружения и константы ---
const token = process.env.BOT_TOKEN;
const port = process.env.PORT || 3000;
const url = process.env.RENDER_URL;
const dbUrl = process.env.DATABASE_URL;

// Проверка наличия всех необходимых переменных
if (!token || !url || !dbUrl) {
  console.error('Ошибка: Не заданы переменные окружения (BOT_TOKEN, RENDER_URL, DATABASE_URL).');
  process.exit(1);
}

const webhookPath = `/bot${token}`;
const fullWebhookUrl = `${url}${webhookPath}`;

// --- Инициализация сервисов ---
const bot = new TelegramBot(token);
const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: dbUrl,
  ssl: {
    rejectUnauthorized: false, // Необходимо для подключения к БД на Render
  },
});

const geocoder = NodeGeocoder({ provider: 'openstreetmap' });

// Простое хранилище состояний для многошаговых команд
const userStates = {};


// =================================================================
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (UTILS)
// =================================================================

/**
 * Преобразует текстовый адрес в географические координаты.
 * @param {string} address - Адрес для геокодирования.
 * @returns {Promise<{lat: number, lon: number}|null>} Координаты или null в случае ошибки.
 */
const geocodeAddress = async (address) => {
  try {
    const res = await geocoder.geocode(address);
    if (res && res.length > 0) {
      return { lat: res[0].latitude, lon: res[0].longitude };
    }
    return null;
  } catch (error) {
    console.error('Ошибка геокодирования:', error);
    return null;
  }
};


// =================================================================
// 3. ФУНКЦИИ ДЛЯ РАБОТЫ С БАЗОЙ ДАННЫХ (DB)
// =================================================================

/**
 * Инициализирует базу данных, создавая таблицы, если они не существуют.
 */
const initDb = async () => {
  const client = await pool.connect();
  try {
    // Убедитесь, что расширение PostGIS включено: `CREATE EXTENSION postgis;`
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        first_name VARCHAR(255),
        username VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS triggers (
        id SERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        location GEOGRAPHY(Point, 4326) NOT NULL,
        radius INT NOT NULL,
        last_state VARCHAR(10) DEFAULT 'outside',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS triggers_location_idx ON triggers USING GIST (location);
    `);
  } finally {
    client.release();
  }
};

const db = {
  async upsertUser(userData) {
    const { id, first_name, username } = userData;
    const query = `
      INSERT INTO users (id, first_name, username) VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username;
    `;
    await pool.query(query, [id, first_name, username]);
  },
  async addTrigger(userId, name, lat, lon, radius) {
    const query = `
      INSERT INTO triggers (user_id, name, location, radius)
      VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5)
      RETURNING *;
    `;
    const res = await pool.query(query, [userId, name, lon, lat, radius]);
    return res.rows[0];
  },
  async getTriggers(userId) {
    const res = await pool.query('SELECT id, name, radius FROM triggers WHERE user_id = $1 ORDER BY name', [userId]);
    return res.rows;
  },
  async deleteTrigger(triggerId, userId) {
    const res = await pool.query('DELETE FROM triggers WHERE id = $1 AND user_id = $2', [triggerId, userId]);
    return res.rowCount > 0;
  },
  async deleteAllUserData(userId) {
      await pool.query('DELETE FROM triggers WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  },
  async checkAllTriggers(userId, lat, lon) {
      const query = `
          SELECT id, name, radius, last_state,
                 ST_DWithin(location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, radius) AS is_inside
          FROM triggers WHERE user_id = $1;
      `;
      const res = await pool.query(query, [userId, lon, lat]);
      return res.rows;
  },
  async updateTriggerState(triggerId, newState) {
      await pool.query('UPDATE triggers SET last_state = $1 WHERE id = $2', [newState, triggerId]);
  }
};


// =================================================================
// 4. ЛОГИКА БОТА (ОБРАБОТЧИКИ КОМАНД И СООБЩЕНИЙ)
// =================================================================

// --- /start и /help ---
bot.onText(/\/(start|help)/, async (msg) => {
  const chatId = msg.chat.id;
  await db.upsertUser(msg.from);
  const text = `
Привет, ${msg.from.first_name}! 🤖

Я GeoTimerBot — ваш личный ассистент для геолокационных напоминаний.

**Основные команды:**
/add - Создать новый гео-триггер.
/list - Показать все ваши триггеры.
/forgetme - Полностью удалить все ваши данные.

Чтобы я мог работать, мне понадобится ваша **Live Location (Трансляция геопозиции)**. Просто прикрепите ее к чату и выберите "Транслировать бессрочно".
  `;
  bot.sendMessage(chatId, text);
});

// --- /add ---
bot.onText(/\/add/, async (msg) => {
  const chatId = msg.chat.id;
  await db.upsertUser(msg.from);
  userStates[chatId] = { step: 'awaiting_name', data: {} };
  bot.sendMessage(chatId, 'Давайте создадим новый триггер. Как вы его назовете? (например, "Дом", "Офис")');
});

// --- /list ---
bot.onText(/\/list/, async (msg) => {
  const chatId = msg.chat.id;
  await db.upsertUser(msg.from);
  const triggers = await db.getTriggers(chatId);

  if (triggers.length === 0) {
    return bot.sendMessage(chatId, 'У вас пока нет триггеров. Создайте первый с помощью /add.');
  }

  const inline_keyboard = triggers.map(t =>
    [{ text: `❌ Удалить "${t.name}" (радиус ${t.radius}м)`, callback_data: `delete_${t.id}` }]
  );

  bot.sendMessage(chatId, 'Ваши гео-триггеры:', {
    reply_markup: { inline_keyboard }
  });
});

// --- /forgetme ---
bot.onText(/\/forgetme/, async (msg) => {
    const chatId = msg.chat.id;
    await db.deleteAllUserData(chatId);
    bot.sendMessage(chatId, 'Все ваши данные были полностью удалены.');
});

// --- Обработка кнопок ---
bot.on('callback_query', async (callbackQuery) => {
  const { message, data, from } = callbackQuery;
  const chatId = message.chat.id;

  if (data.startsWith('delete_')) {
    const triggerId = parseInt(data.split('_')[1]);
    const success = await db.deleteTrigger(triggerId, from.id);
    if (success) {
      bot.answerCallbackQuery(callbackQuery.id, { text: 'Триггер удален!' });
      bot.editMessageText('Триггер был успешно удален.', {
        chat_id: chatId,
        message_id: message.message_id,
      });
    } else {
      bot.answerCallbackQuery(callbackQuery.id, { text: 'Ошибка при удалении.', show_alert: true });
    }
  }
});

// --- Обработка геолокации (Live и обычной) ---
bot.on('location', async (msg) => {
  const chatId = msg.chat.id;
  const state = userStates[chatId];
  const { latitude, longitude } = msg.location;

  // 1. Если это Live Location, проверяем триггеры
  if (msg.live_period) {
    const results = await db.checkAllTriggers(chatId, latitude, longitude);
    for (const trigger of results) {
      const hasEntered = trigger.is_inside && trigger.last_state === 'outside';
      const hasExited = !trigger.is_inside && trigger.last_state === 'inside';

      if (hasEntered) {
        bot.sendMessage(chatId, `🔔 Вы вошли в зону "${trigger.name}"!`);
        await db.updateTriggerState(trigger.id, 'inside');
      } else if (hasExited) {
        bot.sendMessage(chatId, `🔕 Вы покинули зону "${trigger.name}".`);
        await db.updateTriggerState(trigger.id, 'outside');
      }
    }
    return;
  }

  // 2. Если это обычная точка в процессе создания триггера
  if (state && state.step === 'awaiting_location') {
    state.data.location = { lat: latitude, lon: longitude };
    state.step = 'awaiting_radius';
    bot.sendMessage(chatId, `Местоположение получено! Теперь укажите радиус зоны в метрах (например, 100).`);
  }
});

// --- Обработка текстовых сообщений для создания триггера ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const state = userStates[chatId];
  const text = msg.text;

  // Игнорируем команды, геолокацию и если нет активного состояния
  if (!state || !text || text.startsWith('/') || msg.location) return;

  try {
    if (state.step === 'awaiting_name') {
      state.data.name = text;
      state.step = 'awaiting_location';
      bot.sendMessage(chatId, `Отлично! Теперь отправьте геолокацию для "${text}" (точкой на карте или адресом).`);
    } else if (state.step === 'awaiting_location') {
      bot.sendMessage(chatId, 'Ищу адрес на карте...');
      const coords = await geocodeAddress(text);
      if (coords) {
        state.data.location = coords;
        state.step = 'awaiting_radius';
        bot.sendMessage(chatId, `Адрес найден! Теперь укажите радиус зоны в метрах (например, 100).`);
      } else {
        bot.sendMessage(chatId, 'Не удалось найти такой адрес. Попробуйте еще раз или отправьте точку на карте.');
      }
    } else if (state.step === 'awaiting_radius') {
      const radius = parseInt(text);
      if (isNaN(radius) || radius <= 0 || radius > 10000) {
        return bot.sendMessage(chatId, 'Пожалуйста, введите корректное число от 1 до 10000.');
      }
      state.data.radius = radius;
      
      await db.addTrigger(chatId, state.data.name, state.data.location.lat, state.data.location.lon, radius);
      bot.sendMessage(chatId, `✅ Готово! Триггер "${state.data.name}" с радиусом ${radius} м создан.`);
      delete userStates[chatId]; // Завершаем диалог
    }
  } catch (error) {
      console.error("Ошибка в диалоге:", error);
      bot.sendMessage(chatId, "Произошла ошибка, попробуйте снова.");
      delete userStates[chatId];
  }
});


// =================================================================
// 5. ЗАПУСК СЕРВЕРА И ПРИЛОЖЕНИЯ
// =================================================================

/**
 * Главная функция запуска приложения.
 */
async function startApp() {
  try {
    // Устанавливаем вебхук
    await bot.setWebHook(fullWebhookUrl);
    console.log(`Вебхук установлен на ${fullWebhookUrl}`);

    // Инициализируем базу данных
    await initDb();
    console.log('База данных успешно инициализирована.');

    // Роут для получения обновлений от Telegram
    app.post(webhookPath, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });

    // Роут для Uptime Robot
    app.get('/', (req, res) => {
      res.send('GeoTimerBot жив!');
    });

    // Запускаем веб-сервер
    app.listen(port, () => {
      console.log(`Сервер запущен на порту ${port}`);
    });

  } catch (error) {
    console.error('Не удалось запустить приложение:', error);
    process.exit(1);
  }
}

startApp();
