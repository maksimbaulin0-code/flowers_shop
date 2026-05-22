const express = require('express');
const cors = require('cors');
require('dotenv').config();

const db = require('./db');
const yookassa = require('./yookassa');
const telegram = require('./telegram');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Основной эндпоинт для бота (заменяет основной Webhook n8n)
app.post('/api/webhook', async (req, res) => {
  const { action, ...body } = req.body;

  try {
    switch (action) {
      case 'get_items': {
        const result = await db.query('SELECT * FROM flowers_catalog');
        return res.json(result.rows);
      }

      case 'admin_add': {
        const { name, price, image_url, stock, color, flower_type } = body;
        const result = await db.query(
          `INSERT INTO flowers_catalog (name, price, image_url, stock, color, flower_type) 
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [name, price, image_url, stock, color, flower_type]
        );
        return res.json(result.rows[0]);
      }

      case 'pay': {
        const { items, customerName, customerPhone, username, userId, address, street, house, apartment, entrance, intercom, comment } = body;
        const item = items[0]; // В n8n брался только первый элемент
        
        // Получаем товар из БД для проверки и стоимости
        const productRes = await db.query('SELECT * FROM flowers_catalog WHERE id = $1', [item.productId]);
        if (productRes.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
        const product = productRes.rows[0];

        const totalAmount = product.price * item.count;

        // Создаем платеж в ЮKassa
        const payment = await yookassa.createPayment(totalAmount, `Заказ: ${product.name}`, {
          customerName,
          customerPhone,
          count: item.count.toString(),
          productId: item.productId.toString(),
          username
        });

        // Сохраняем заказ в БД
        const itemsJson = JSON.stringify({
          productId: product.id,
          name: product.name,
          price: product.price,
          count: item.count
        });

        await db.query(
          `INSERT INTO flowers_orders 
          (order_id, user_id, amount, username, status, flower_name, address, street, house, apartment, entrance, intercom, comment, items)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [payment.id, userId, payment.amount.value, username, payment.status, product.name, address, street, house, apartment, entrance, intercom, comment, itemsJson]
        );

        return res.json({ paymentUrl: payment.confirmation.confirmation_url, orderId: payment.id });
      }

      case 'update_stock': {
        // В n8n не было явной логики в switch кроме названия, но обычно это делает админ
        const { id, totalStock } = body;
        const result = await db.query('UPDATE flowers_catalog SET stock = $1 WHERE id = $2 RETURNING *', [totalStock, id]);
        return res.json(result.rows[0] || { status: 'error' });
      }

      case 'check_status': {
        const { orderId } = body;
        const result = await db.query('SELECT status FROM flowers_orders WHERE order_id = $1', [orderId]);
        if (result.rows.length > 0) {
            return res.json({ status: result.rows[0].status });
        }
        return res.status(404).json({ error: 'Order not found' });
      }

      case 'get_orders': {
        const { userId } = body;
        const result = await db.query('SELECT * FROM flowers_orders WHERE user_id = $1', [userId]);
        return res.json(result.rows);
      }

      case 'cancel_order': {
        const { orderId, username } = body;
        
        // Обновляем статус в БД
        const updateRes = await db.query(
            "UPDATE flowers_orders SET status = 'cancelled' WHERE order_id = $1 RETURNING *", 
            [orderId]
        );

        if (updateRes.rows.length > 0) {
            const order = updateRes.rows[0];
            const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
            
            // Уведомление в Telegram о возврате/отмене
            const text = `Запрос на возврат средств по заказу №${order.order_id}

Юзернейм: @${username}
Состав заказа:
  Наименование: ${items?.name || order.flower_name}
  Кол-во: ${items?.count || order.count}
  Итоговая сумма: ${order.amount}₽
Статус: ${order.status}
Адрес доставки: ${order.address}
Комментарий к заказу: ${order.comment || 'Нет'}`;

            await telegram.sendMessage(text);
            return res.json({ status: 'cancelled' });
        }
        return res.status(404).json({ error: 'Order not found' });
      }

      case 'update_order_status': {
        // В n8n этого не было явно расписано, но добавим
        const { orderId, status } = body;
        const result = await db.query('UPDATE flowers_orders SET status = $1 WHERE order_id = $2 RETURNING *', [status, orderId]);
        return res.json(result.rows[0] || { status: 'error' });
      }

      case 'get_all_orders': {
        const result = await db.query('SELECT * FROM flowers_orders');
        return res.json(result.rows);
      }

      case 'admin_delete': {
        const { id } = body;
        await db.query('DELETE FROM flowers_catalog WHERE id = $1', [id]);
        return res.json({ success: true });
      }

      default:
        return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Эндпоинт для вебхуков от ЮKassa (заменяет Webhook1 в n8n)
app.post('/api/yookassa/webhook', async (req, res) => {
  try {
    const event = req.body;
    
    // ЮKassa присылает событие payment.succeeded или payment.waiting_for_capture
    if (event.event === 'payment.succeeded' || event.event === 'payment.waiting_for_capture') {
        const paymentObj = event.object;
        
        // Обновляем статус заказа в БД на paid
        const orderRes = await db.query(
            "UPDATE flowers_orders SET status = 'paid' WHERE order_id = $1 RETURNING *", 
            [paymentObj.id]
        );

        if (orderRes.rows.length > 0) {
            const order = orderRes.rows[0];
            const meta = paymentObj.metadata || {};

            // Уменьшаем количество товара в наличии
            if (meta.productId && meta.count) {
                await db.query('UPDATE flowers_catalog SET stock = stock - $1 WHERE id = $2', [meta.count, meta.productId]);
            }

            // Отправляем уведомление в Telegram о новом оплаченном заказе
            const text = `Новый заказ (ОПЛАЧЕН): 
${order.flower_name} / ${meta.count || 1}шт
Имя заказчика: ${meta.customerName}
Номер заказчика: ${meta.customerPhone}
ТГ заказчика: @${meta.username}
Адрес доставки: ${order.address}
Комментарий: ${order.comment || 'Нет'}`;

            await telegram.sendMessage(text);
        }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Yookassa Webhook Error:', error);
    res.status(500).send('Error processing webhook');
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

module.exports = app;
