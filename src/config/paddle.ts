// src/config/paddle.ts
import { Paddle, Environment } from '@paddle/paddle-node-sdk';

const apiKey = process.env.PADDLE_API_KEY;
const webhookSecret = (process.env.PADDLE_WEBHOOK_SECRET_KEY || '').replace(/['"]/g, '').trim();
const paddleEnv = process.env.PADDLE_ENVIRONMENT || 'sandbox';

if (!apiKey) {
  console.warn('[config/paddle] WARNING: PADDLE_API_KEY is not defined in environment variables.');
}

if (!webhookSecret) {
  console.warn('[config/paddle] WARNING: PADDLE_WEBHOOK_SECRET_KEY is not defined.');
}

export const paddleConfig = {
  apiKey: apiKey || '',
  webhookSecret: webhookSecret || '',
  environment: paddleEnv === 'production' ? Environment.production : Environment.sandbox,
};

// Initialize and export the single server-side Paddle Billing client instance
export const paddleClient = new Paddle(paddleConfig.apiKey, {
  environment: paddleConfig.environment,
});