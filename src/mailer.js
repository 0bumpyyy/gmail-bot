import nodemailer from 'nodemailer';
import { SocksProxyAgent } from 'socks-proxy-agent';
import axios from 'axios';
import { prisma } from './db.js';
import dotenv from 'dotenv';
dotenv.config();
export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// Простая и надежная проверка через axios
async function checkProxy(proxyUrl) {
    try {
        const httpsAgent = new SocksProxyAgent(proxyUrl);
        // Делаем запрос через прокси
        await axios.get('https://www.google.com', {
            httpsAgent,
            timeout: 5000
        });
        return true;
    }
    catch (e) {
        return false;
    }
}
export async function runMailing(config, logCallback) {
    const proxyUrl = process.env.PROXY_URL;
    const agent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;
    if (proxyUrl) {
        logCallback("🔍 Проверка прокси...");
        if (!(await checkProxy(proxyUrl))) {
            logCallback("❌ Ошибка прокси! Проверьте настройки в .env");
            return;
        }
        logCallback("✅ Прокси OK!");
    }
    const accounts = await prisma.emailAccount.findMany({ where: { isActive: true } });
    for (const account of accounts) {
        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: {
                user: account.email,
                pass: account.password
            },
            // Передаем агент в настройки nodemailer
            socket: agent
        });
        logCallback(`🚀 Рассылка через ${account.email}`);
        // ... далее твоя логика отправки
    }
}
