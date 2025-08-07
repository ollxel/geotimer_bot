// =================================================================
// GeoTimerBot 2.0
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
// !!! ВАЖНО: URL вашего будущего веб-приложения. Пока это просто заглушка.
const webAppUrl = process.env.WEB_APP_URL || "https://telegram.org"; // Замените на реальный URL, когда он будет

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
const userStates = {}; // Оставляем для старого способа добавления, если понадобится


// =================================================================
// 2. ФУНКЦИИ ДЛЯ РАБОТЫ С БАЗОЙ ДАННЫХ (без изменений)
// =================================================================
const initDb = async () => { /* ... код без изменений ... */ };
const db = { /* ... код без изменений ... */ };
// (Полный код этих функций я спрятал для краткости, он идентичен предыдущей версии)

// =================================================================
// 3. ЛОГИКА БОТА (ВЕРСИЯ 2.0)
// =================================================================

// --- /start и /help ---
bot.onText(/\/(start|help)/, async (msg) => {
  const chatId = msg.chat.id;
  await db.upsertUser(msg.from);
  const text = `
Привет, ${msg.from.first_name}! 🤖

Это **GeoTimerBot 2.0** — я стал гораздо удобнее.

Забудьте о неудобных командах. Теперь все управление происходит через удобный **интерфейс, который открывается прямо в чате**.

Нажмите /menu, чтобы начать.

Для работы мне по-прежнему нужна ваша **Live Location (Трансляция геопозиции)**. Без нее магия не случится.
  `;
  bot.sendMessage(chatId, text, {
    reply_markup: {
      keyboard: [[{ text: "Главное меню" }]], // Добавляем постоянную кнопку меню
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
                [{ text: '💡 Как включить геолокацию?', web_app: { url: `${webAppUrl}/help` } }]
            ]
        }
    });
});


// --- ОБРАБОТКА ГЕОЛОКАЦИИ (ВЕРСИЯ 2.0 С ДЕБАГОМ) ---
bot.on('location', async (msg) => {
    const chatId = msg.chat.id;
    const { latitude, longitude } = msg.location;

    // 1. Если это Live Location, запускаем основную логику
    if (msg.live_period) {
        console.log(`[${chatId}] Получено live-обновление: ${latitude}, ${longitude}`);
        try {
            const triggers = await db.checkAllTriggers(chatId, latitude, longitude);
            
            if (triggers.length === 0) return;

            console.log(`[${chatId}] Найдено ${triggers.length} триггеров для проверки.`);

            for (const trigger of triggers) {
                const { id, name, last_state, is_inside } = trigger;
                console.log(`[${chatId}] Проверка триггера "${name}": Состояние в БД: ${last_state}. Фактически внутри: ${is_inside}.`);

                const hasEntered = is_inside && last_state === 'outside';
                const hasExited = !is_inside && last_state === 'inside';

                if (hasEntered) {
                    console.log(`[${chatId}] СОБЫТИЕ: Вход в зону "${name}". Отправка уведомления и обновление состояния.`);
                    bot.sendMessage(chatId, `🔔 Вы вошли в зону "${name}"!`);
                    await db.updateTriggerState(id, 'inside');
                } else if (hasExited) {
                    console.log(`[${chatId}] СОБЫТИЕ: Выход из зоны "${name}". Отправка уведомления и обновление состояния.`);
                    bot.sendMessage(chatId, `🔕 Вы покинули зону "${name}".`);
                    await db.updateTriggerState(id, 'outside');
                } else {
                    console.log(`[${chatId}] Для триггера "${name}" нет изменений состояния. Пропускаем.`);
                }
            }
        } catch (error) {
            console.error(`[${chatId}] Ошибка при обработке live location:`, error);
        }
    }
});

// --- Команда /forgetme для удаления данных ---
bot.onText(/\/forgetme/, async (msg) => {
    const chatId = msg.chat.id;
    await db.deleteAllUserData(chatId);
    bot.sendMessage(chatId, 'Все ваши данные были полностью удалены.');
});


// =================================================================
// 4. ЗАПУСК СЕРВЕРА И ПРИЛОЖЕНИЯ
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

// --- Полный код скрытых функций DB для копирования ---
const geocodeAddress = async (address) => {
  try {
    const res = await geocoder.geocode(address);
    if (res && res.length > 0) return { lat: res[0].latitude, lon: res[0].longitude };
    return null;
  } catch (error) { console.error('Ошибка геокодирования:', error); return null; }
};

initDb = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (id BIGINT PRIMARY KEY, first_name VARCHAR(255), username VARCHAR(255), created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS triggers (id SERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id) ON DELETE CASCADE, name VARCHAR(255) NOT NULL, location GEOGRAPHY(Point, 4326) NOT NULL, radius INT NOT NULL, last_state VARCHAR(10) DEFAULT 'outside', created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS triggers_location_idx ON triggers USING GIST (location);
    `);
  } finally { client.release(); }
};

db.upsertUser = async (userData) => {
  const { id, first_name, username } = userData;
  await pool.query(`INSERT INTO users (id, first_name, username) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username;`, [id, first_name, username]);
};
db.addTrigger = async (userId, name, lat, lon, radius) => {
  const res = await pool.query(`INSERT INTO triggers (user_id, name, location, radius) VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5) RETURNING *;`, [userId, name, lon, lat, radius]);
  return res.rows[0];
};
db.getTriggers = async (userId) => {
  const res = await pool.query('SELECT id, name, radius FROM triggers WHERE user_id = $1 ORDER BY name', [userId]);
  return res.rows;
};
db.deleteTrigger = async (triggerId, userId) => {
  const res = await pool.query('DELETE FROM triggers WHERE id = $1 AND user_id = $2', [triggerId, userId]);
  return res.rowCount > 0;
};
db.deleteAllUserData = async (userId) => {
  await pool.query('DELETE FROM triggers WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
};
db.checkAllTriggers = async (userId, lat, lon) => {
  const res = await pool.query(`SELECT id, name, radius, last_state, ST_DWithin(location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, radius) AS is_inside FROM triggers WHERE user_id = $1;`, [userId, lon, lat]);
  return res.rows;
};
db.updateTriggerState = async (triggerId, newState) => {
  await pool.query('UPDATE triggers SET last_state = $1 WHERE id = $2', [newState, triggerId]);
};

// --- Запуск ---
startApp();
