const axios = require('axios');
require('dotenv').config();

const YOOKASSA_API_URL = 'https://api.yookassa.ru/v3';
const SHOP_ID = process.env.YOOKASSA_SHOP_ID;
const SECRET_KEY = process.env.YOOKASSA_SECRET_KEY;

// Функция для создания платежа
async function createPayment(amount, description, metadata) {
  try {
    const idempotenceKey = Math.random().toString(36).substring(2, 15) + Date.now().toString();
    const returnUrl = process.env.YOOKASSA_RETURN_URL || 'https://example.com/return';

    const payload = {
      amount: {
        value: amount.toString(),
        currency: 'RUB'
      },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: returnUrl
      },
      description: description,
      metadata: metadata
    };

    const response = await axios.post(`${YOOKASSA_API_URL}/payments`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Idempotence-Key': idempotenceKey,
      },
      auth: {
        username: SHOP_ID,
        password: SECRET_KEY
      }
    });

    return response.data;
  } catch (error) {
    console.error('Ошибка при создании платежа ЮKassa:', error.response ? error.response.data : error.message);
    throw error;
  }
}

module.exports = {
  createPayment
};
