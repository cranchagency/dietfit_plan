import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import { isEmail } from './src/utils/validation.js';
import { logger } from './src/utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

// Инициализация Supabase клиента
const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.VITE_SUPABASE_ANON_KEY!
);

// Конфигурация CloudPayments
const CLOUD_PAYMENTS_PUBLIC_ID = process.env.CLOUD_PAYMENTS_PUBLIC_ID;
const CLOUD_PAYMENTS_API_SECRET = process.env.CLOUD_PAYMENTS_API_SECRET;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  tls: {
    ciphers: 'SSLv3'
  }
});

const app = express();

// Важно: эти middleware должны быть определены ДО всех маршрутов
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Функция для проверки подписи CloudPayments
function verifyCloudPaymentsSignature(req: Request): boolean {
  if (!CLOUD_PAYMENTS_API_SECRET) {
    logger.error('CLOUD_PAYMENTS_API_SECRET is not defined');
    return false;
  }

  const message = Object.keys(req.body)
    .sort()
    .map(key => req.body[key])
    .join('');
  
  const hmac = crypto.createHmac('sha256', CLOUD_PAYMENTS_API_SECRET)
    .update(message)
    .digest('base64');
  
  const signature = req.get('Content-HMAC');
  logger.info('Signature verification', { 
    calculated: hmac, 
    received: signature,
    match: hmac === signature 
  });
  
  return hmac === signature;
}

async function sendEmail(email: string, userName: string | undefined): Promise<void> {
  try {
    logger.info('Attempting to send email', { email, userName });

    const mailOptions = {
      from: `"FoodPlan" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Ваш персональный план питания',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #22c55e;">Здравствуйте${userName ? `, ${userName}` : ''}!</h2>
          <p>Спасибо за заказ персонального плана питания.</p>
          <p>Во вложении вы найдете ваш индивидуальный план.</p>
          <p style="margin-top: 24px;">С уважением,<br>Команда FoodPlan</p>
        </div>
      `,
      attachments: [{
        filename: 'food-plan.pdf',
        path: path.join(__dirname, 'public', 'food-plan.pdf')
      }]
    };

    await transporter.sendMail(mailOptions);
    logger.info('Email sent successfully', { email });
  } catch (error) {
    logger.error('Failed to send email', { error, email });
    throw error;
  }
}

// API маршруты должны быть определены ДО статических файлов
app.post('/api/payment-success', async (req: Request, res: Response) => {
  try {
    logger.info('Received payment success request', { body: req.body });
    
    const { email, transactionId } = req.body;

    if (!email || !isEmail(email)) {
      logger.warn('Invalid email received', { email });
      return res.status(400).json({ success: false, error: 'Invalid email' });
    }

    // Создаем запись о пользователе
    const { data: user, error: userError } = await supabase
      .from('users')
      .upsert({
        email,
        subscription_id: transactionId,
        payment_count: 1,
        next_payment_date: new Date(Date.now() + 24 * 60 * 60 * 1000), // +24 часа
        plan_sent: [new Date()]
      })
      .select()
      .single();

    if (userError) {
      logger.error('Failed to create user record', { error: userError });
      throw userError;
    }

    logger.info('User record created/updated', { user });

    // Отправляем email
    await sendEmail(email, undefined);

    res.json({ success: true });
  } catch (error) {
    logger.error('Payment success handler error', { error });
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Internal server error' 
    });
  }
});

app.post('/api/webhook', async (req: Request, res: Response) => {
  try {
    logger.info('Received webhook request', { 
      headers: req.headers,
      body: req.body 
    });

    if (!verifyCloudPaymentsSignature(req)) {
      logger.warn('Invalid webhook signature');
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }

    const { Email: email, TransactionId, Status, Amount, Type } = req.body;
    
    logger.info('Processing webhook', { type: Type, status: Status, email });

    switch (Type) {
      case 'Pay':
        if (Status === 'Completed') {
          const { data: user, error: userError } = await supabase
            .from('users')
            .select()
            .eq('email', email)
            .single();

          if (userError) {
            logger.error('Failed to fetch user', { error: userError });
            throw userError;
          }

          if (!user) {
            logger.warn('User not found', { email });
            throw new Error('User not found');
          }

          const newPaymentCount = (user.payment_count || 0) + 1;
          const nextPaymentDate = newPaymentCount < 5 
            ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) 
            : null;

          const { error: updateError } = await supabase
            .from('users')
            .update({
              payment_count: newPaymentCount,
              next_payment_date: nextPaymentDate,
              plan_sent: [...(user.plan_sent || []), new Date()]
            })
            .eq('email', email);

          if (updateError) {
            logger.error('Failed to update user', { error: updateError });
            throw updateError;
          }

          await sendEmail(email, undefined);
        }
        break;

      case 'Fail':
        logger.warn('Payment failed', { email, TransactionId, Amount });
        break;

      case 'Recurrent':
        if (Status === 'Completed') {
          const { data: user, error: userError } = await supabase
            .from('users')
            .select()
            .eq('email', email)
            .single();

          if (userError || !user) {
            logger.error('Failed to fetch user for recurrent payment', { error: userError });
            throw userError || new Error('User not found');
          }

          const newPaymentCount = (user.payment_count || 0) + 1;
          const { error: updateError } = await supabase
            .from('users')
            .update({
              payment_count: newPaymentCount,
              next_payment_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
              plan_sent: [...(user.plan_sent || []), new Date()]
            })
            .eq('email', email);

          if (updateError) {
            logger.error('Failed to update user for recurrent payment', { error: updateError });
            throw updateError;
          }

          await sendEmail(email, undefined);
        }
        break;

      case 'Cancel':
        logger.info('Payment cancelled', { email, TransactionId });
        const { error: cancelError } = await supabase
          .from('users')
          .update({
            next_payment_date: null
          })
          .eq('email', email);

        if (cancelError) {
          logger.error('Failed to cancel subscription', { error: cancelError });
          throw cancelError;
        }
        break;

      default:
        logger.warn('Unknown webhook type', { type: Type });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Webhook handler error', { error });
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Internal server error' 
    });
  }
});

// Тестовый endpoint для проверки работы сервера
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Статические файлы должны обрабатываться ПОСЛЕ API маршрутов
app.use(express.static(path.join(__dirname, 'dist')));

// Обработка всех остальных маршрутов для SPA должна быть ПОСЛЕДНЕЙ
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  logger.info(`Server is running on port ${port}`);
});