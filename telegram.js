const axios = require('axios');
require('dotenv').config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendMessage(text, chatId = CHAT_ID) {
  if (!BOT_TOKEN || !chatId) {
    console.warn('Telegram token or chat_id is missing. Skip sending message.');
    return;
  }

  try {
    await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
      chat_id: chatId,
      text: text
    });
  } catch (error) {
    console.error('Ошибка отправки сообщения в Telegram:', error.response ? error.response.data : error.message);
  }
}

module.exports = {
  sendMessage
};
