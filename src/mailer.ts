import * as nodemailer from 'nodemailer';
import { SocksClient } from 'socks';
import * as dotenv from 'dotenv';
import { prisma } from './db.js';

dotenv.config();

const proxyUrl = process.env.PROXY_URL || '';
const LINK_API_URL = 'https://api.k7r4q9p2z1x1.cfd/api/protected';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const mailingState: Record<string, any> = {};

const platformToService: Record<string, string> = {
    MERCARI_USA:  'mercari3_usa',
    OFFERUP_USA:  'offerup3_usa',
    DEPOP_USA:    'depop3_usa',
    DEPOP_UK:     'depop3_uk',
    POSHMARK_USA: 'poshmark3_eu',
};

async function generateLink(platform: string, userId: string, title: string, userToken: string): Promise<string> {
    try {
        const service = platformToService[platform] || 'depop3_usa';
        const response = await fetch(LINK_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: userToken,
                title,
                service,
                userId
            })
        });

        if (!response.ok) throw new Error(`API статус: ${response.status}`);
        const data = await response.json() as any;

        if (data.error || !data.message) {
            throw new Error(data.error || 'API вернул ошибку');
        }

        return data.message || data.fish_link || '#';
    } catch (err: any) {
        console.error(`⚠️ Ошибка генерации ссылки: ${err.message}`);
        return '#';
    }
}

export async function runMailing(
    config: { delayRange: { min: number; max: number }; userId: string },
    logCallback: (msg: string) => void
) {
    const { userId } = config;
    const template = await prisma.template.findFirst({ where: { telegramId: userId, isActive: true } });
    const accounts = await prisma.emailAccount.findMany({ where: { isActive: true, telegramId: userId } });
    const user = await prisma.user.findUnique({ where: { telegramId: userId } });

    if (!template || accounts.length === 0) {
        logCallback("❌ Ошибка: нет активного шаблона или аккаунтов.");
        return;
    }

    if (!user?.token) {
        logCallback("❌ Ошибка: токен API не установлен. Добавьте его в управлении токеном.");
        return;
    }

    mailingState[userId] = 'RUNNING';
    logCallback(`🚀 Запуск параллельной рассылки через ${accounts.length} аккаунтов...`);
    await Promise.all(accounts.map(acc => processAccount(acc, template, config, logCallback, userId, user.token)));
    logCallback("🏁 Все потоки завершены.");
    mailingState[userId] = 'STOPPED';
}

async function processAccount(account: any, template: any, config: any, logCallback: (msg: string) => void, userId: string, userToken: string) {
    // Парсим JSON список получателей
    let recipientsList: { email: string; name: string }[] = [];
    try {
        recipientsList = account.recipients ? JSON.parse(account.recipients) : [];
    } catch {
        logCallback(`❌ [${account.email}] Ошибка парсинга JSON получателей`);
        return;
    }

    let index = account.currentIndex;
    const proxyUri = new URL(proxyUrl);

    while (index < recipientsList.length) {
        if (mailingState[userId] === 'STOPPED') return;
        while (mailingState[userId] === 'PAUSED') await delay(5000);

        const recipient = recipientsList[index];
        const targetEmail = recipient.email;
        const targetName = recipient.name || '';

        try {
            const generatedLink = await generateLink(template.platform, userId, targetName, userToken);    // было template.name

            const info = await SocksClient.createConnection({
                proxy: { host: proxyUri.hostname, port: parseInt(proxyUri.port), type: 5, userId: proxyUri.username, password: proxyUri.password },
                command: 'connect',
                destination: { host: 'smtp.gmail.com', port: 465 },
                timeout: 15000
            });

            const transporter = nodemailer.createTransport({
                connection: info.socket,
                host: 'smtp.gmail.com', port: 465, secure: true,
                auth: { user: account.email, pass: account.password }
            });

            let body = template.body
                .replace(/{{ORDER_ID}}/g, `#${Math.floor(Math.random() * 90000 + 10000)}`)
                .replace(/{{LINK}}/g, generatedLink)
                .replace(/{{NAME}}/g, targetName);

            await transporter.sendMail({
                from: template.senderName ? `${template.senderName} <${account.email}>` : account.email,
                to: targetEmail,
                subject: template.subject,
                [template.type === 'HTML' ? 'html' : 'text']: body
            });

            info.socket.destroy();
            index++;
            await prisma.emailAccount.update({ where: { id: account.id }, data: { currentIndex: index } });
            logCallback(`✅ [${account.email}] → ${targetName} <${targetEmail}> | 🔗 ${generatedLink}`);
            await delay(Math.floor(Math.random() * (config.delayRange.max - config.delayRange.min + 1) + config.delayRange.min) * 1000);
        } catch (err: any) {
            logCallback(`❌ [${account.email}] Ошибка ${targetEmail}: ${err.message}`);
            if (err.message.includes('Authentication')) break;
            index++;
            await delay(5000);
        }
    }
}