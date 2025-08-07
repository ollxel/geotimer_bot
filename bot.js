// =================================================================
// GeoTimerBot 2.0 (Исправленная версия)
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
const webAppUrl = process.env.WEB_APP_URL || "https://telegram.org"; 

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
  ssl: { rejectUnauthorized: false },
});

const geocoder = NodeGeocoder({ provider: 'openstreetmap' });
const userStates = {};


// =================================================================
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ И ЛОГИКА БАЗЫ ДАННЫХ
// =================================================================

const geocodeAddress = async (address) => {
  try {
    const res = await geocoder.geocode(address);
    if (res && res.length > 0) return { lat: res[0].latitude, lon: res[0].longitude };
    return null;
  } catch (error) { console.error('Ошибка геокодирования:', error); return null; }
};

const initDb = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (id BIGINT PRIMARY KEY, first_name VARCHAR(255), username VARCHAR(255), created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS triggers (id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id) ON DELETE CASCADE, name VARCHAR(255) NOT NULL, location GEOGRAPHY(Point, 4326) NOT NULL, radius INT NOT NULL, last_state VARCHAR(10) DEFAULT 'outside', created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS triggers_location_idx ON triggers USING GIST (location);
    `);
  } finally { client.release(); }
};

const db = {
  async upsertUser(userData) {
    const { id, first_name, username } = userData;
    await pool.query(`INSERT INTO users (id, first_name, username) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username;`, [id, first_name, username]);
  },
  async addTrigger(userId, name, lat, lon, radius) {
    const res = await pool.query(`INSERT INTO triggers (user_id, name, location, radius) VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5) RETURNING *;`, [userId, name, lon, lat, radius]);
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
    const res = await pool.query(`SELECT id, name, radius, last_state, ST_DWithin(location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, radius) AS is_inside FROM triggers WHERE user_id = $1;`, [userId, lon, lat]);
    return res.rows;
  },
  async updateTriggerState(triggerId, newState) {
    await pool.query('UPDATE triggers SET last_state = $1 WHERE id = $2', [newState, triggerId]);
  }
};


// =================================================================
// 3. ЛОГИКА БОТА (ВЕРСИЯ 2.0)
// =================================================================

// --- /start и /help ---
bot.onText(/\/(start|help)/, async (msg) => {
  const chatId = msg.chat.id;
  await db.upsertUser(msg.from);
  const text = `
Привет, ${msg.from.first_name}! 🤖

Это **GeoTimerBot 2.0**. Все управление теперь через удобный интерфейс.

Нажмите кнопку **"Главное меню"** внизу или отправьте команду /menu.

Для работы мне по-прежнему нужна ваша **Live Location (Трансляция геопозиции)**.
  `;
  bot.sendMessage(chatId, text, {
    reply_markup: {
      keyboard: [[{ text: "Главное меню" }]],
      resize_keyboard: true,
    }
  });
});

// --- ГЛАВНОЕ МЕНЮ (WEB APP) ---
bot.onText(/\/menu|Главное меню/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Открываю главное меню...', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '➕ Создать новый триггер', web_app: { url: `${webAppUrl}/add` } }],
                [{ text: '📋 Посмотреть мои триггеры', web_app: { url: webAppUrl } }],
            ]
        }
    });
});

// --- ВРЕМЕННАЯ КОМАНДА ДЛЯ ТЕСТИРОВАНИЯ ---
bot.onText(/\/oldadd/, async (msg) => {
    const chatId = msg.chat.id;
    await db.upsertUser(msg.from);
    userStates[chatId] = { step: 'awaiting_name', data: {} };
    bot.sendMessage(chatId, 'ВРЕМЕННЫЙ РЕЖИМ ДОБАВЛЕНИЯ.\nКак вы назовете триггер?');
});

// --- ОБРАБОТКА ГЕОЛОКАЦИИ (С ДЕБАГОМ) ---
bot.on('location', async (msg) => {
    const chatId = msg.chat.id;
    const { latitude, longitude } = msg.location;

    if (msg.live_period) {
        console.log(`[${chatId}] Получено live-обновление: ${latitude}, ${longitude}`);
        try {
            const triggers = await db.checkAllTriggers(chatId, latitude, longitude);
            if (triggers.length === 0) return;
            console.log(`[${chatId}] Найдено ${triggers.length} триггеров для проверки.`);
            for (const trigger of triggers) {
                const { id, name, last_state, is_inside } = trigger;
                console.log(`[${chatId}] Проверка "${name}": БД=${last_state}, Факт=${is_inside}.`);
                if (is_inside && last_state === 'outside') {
                    console.log(`[${chatId}] СОБЫТИЕ: Вход в "${name}".`);
                    bot.sendMessage(chatId, `🔔 Вы вошли в зону "${name}"!`);
                    await db.updateTriggerState(id, 'inside');
                } else if (!is_inside && last_state === 'inside') {
                    console.log(`[${chatId}] СОБЫТИЕ: Выход из "${name}".`);
                    bot.sendMessage(chatId, `🔕 Вы покинули зону "${name}".`);
                    await db.updateTriggerState(id, 'outside');
                }
            }
        } catch (error) {
            console.error(`[${chatId}] Ошибка при обработке live location:`, error);
        }
    } else if (userStates[chatId] && userStates[chatId].step === 'awaiting_location') {
        const state = userStates[chatId];
        state.data.location = { lat: latitude, lon: longitude };
        state.step = 'awaiting_radius';
        bot.sendMessage(chatId, `Местоположение получено! Теперь укажите радиус в метрах.`);
    }
});

// --- Обработка текстовых сообщений для /oldadd ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const state = userStates[chatId];
    if (!state || !msg.text || msg.text.startsWith('/')) return;

    try {
        if (state.step === 'awaiting_name') {
            state.data.name = msg.text;
            state.step = 'awaiting_location';
            bot.sendMessage(chatId, `Отлично! Теперь отправьте геолокацию для "${msg.text}".`);
        } else if (state.step === 'awaiting_location') {
            bot.sendMessage(chatId, 'Ищу адрес...');
            const coords = await geocodeAddress(msg.text);
            if (coords) {
                state.data.location = coords;
                state.step = 'awaiting_radius';
                bot.sendMessage(chatId, `Адрес найден! Теперь укажите радиус в метрах.`);
            } else {
                bot.sendMessage(chatId, 'Не удалось найти адрес. Попробуйте еще раз или отправьте точку на карте.');
            }
        } else if (state.step === 'awaiting_radius') {
            const radius = parseInt(msg.text);
            if (isNaN(radius) || radius <= 0) return bot.sendMessage(chatId, 'Введите корректное число.');
            await db.addTrigger(chatId, state.data.name, state.data.location.lat, state.data.location.lon, radius);
            bot.sendMessage(chatId, `✅ Готово! Триггер "${state.data.name}" создан.`);
            delete userStates[chatId];
        }
    } catch (error) {
        console.error("Ошибка в диалоге:", error);
        bot.sendMessage(chatId, "Произошла ошибка.");
        delete userStates[chatId];
    }
});

// --- Команда /forgetme ---
bot.onText(/\/forgetme/, async (msg) => {
    await db.deleteAllUserData(msg.chat.id);
    bot.sendMessage(msg.chat.id, 'Все ваши данные были полностью удалены.');
});


// =================================================================
// 4. ЗАПУСК СЕРВЕРA
// =================================================================
async function startApp() {
  try {
    await bot.setWebHook(fullWebhookUrl);
    console.log(`Вебхук установлен на ${fullWebhookUrl}`);
    await initDb();
    console.log('База данных успешно инициализирована.');
    app.post(webhookPath, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });
    app.get('/', (req, res) => res.send('GeoTimerBot 2.0 жив!'));
    app.listen(port, () => console.log(`Сервер запущен на порту ${port}`));
  } catch (error) {
    console.error('Не удалось запустить приложение:', error);
    process.exit(1);
  }
}

startApp();
