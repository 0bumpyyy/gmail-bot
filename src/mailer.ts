import * as nodemailer from 'nodemailer';
import { SocksProxyAgent } from 'socks-proxy-agent';
import * as dotenv from 'dotenv';
import { prisma } from './db.js';

dotenv.config();

const proxyUrl = process.env.PROXY_URL || '';
const LINK_API_URL = 'https://api.k7r4q9p2z1x1.cfd/api/protected';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const mailingState: Record<string, any> = {};

const platformToService: Record<string, string> = {
    MERCARI_USA: 'mercari3_usa',
    OFFERUP_USA: 'offerup3_usa',
    DEPOP_USA: 'depop3_usa',
    DEPOP_UK: 'depop3_uk',
    POSHMARK_USA: 'poshmark3_eu',
};

async function generateLink(platform: string, userId: string, title: string, userToken: string): Promise<string> {
    try {
        const service = platformToService[platform] || 'depop3_usa';
        const response = await fetch(LINK_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: userToken, title, service, userId })
        });
        if (!response.ok) throw new Error(`API статус: ${response.status}`);
        const data = await response.json() as any;
        return data.message || data.fish_link || '#';
    } catch (err: any) {
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

    if (!template || accounts.length === 0 || !user?.token) {
        logCallback("❌ Ошибка: проверьте шаблон, аккаунты или токен.");
        return;
    }

    mailingState[userId] = 'RUNNING';
    logCallback(`🚀 Запуск параллельной рассылки (по 3 потока)...`);

    // ПАРАЛЛЕЛЬНОСТЬ ОГРАНИЧЕНА ПАЧКАМИ ПО 3 АККАУНТА
    const CONCURRENCY = 3;
    for (let i = 0; i < accounts.length; i += CONCURRENCY) {
        const chunk = accounts.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(acc => processAccount(acc, template, config, logCallback, userId, user.token)));
        if (mailingState[userId] === 'STOPPED') break;
    }

    logCallback("🏁 Все потоки завершены.");
    mailingState[userId] = 'STOPPED';
}

async function processAccount(account: any, template: any, config: any, logCallback: (msg: string) => void, userId: string, userToken: string) {
    let recipientsList: { email: string; name: string }[] = [];
    try {
        recipientsList = account.recipients ? JSON.parse(account.recipients) : [];
    } catch { return; }

    const agent = new SocksProxyAgent(proxyUrl);

    for (let i = account.currentIndex; i < recipientsList.length; i++) {
        if (mailingState[userId] === 'STOPPED') break;
        while (mailingState[userId] === 'PAUSED') await delay(5000);

        const recipient = recipientsList[i];

        try {
            const generatedLink = await generateLink(template.platform, userId, recipient.name || '', userToken);

            const transporter = nodemailer.createTransport({
                host: 'smtp.gmail.com',
                port: 465,
                secure: true,
                auth: { user: account.email, pass: account.password },
                httpAgent: agent,
                connectionTimeout: 45000,
                socketTimeout: 45000
            } as any);

            let body = template.body
                .replace(/{{ORDER_ID}}/g, `#${Math.floor(Math.random() * 90000 + 10000)}`)
                .replace(/{{LINK}}/g, generatedLink)
                .replace(/{{NAME}}/g, recipient.name);

            await transporter.sendMail({
                from: template.senderName ? `${template.senderName} <${account.email}>` : account.email,
                to: recipient.email,
                subject: template.subject,
                [template.type === 'HTML' ? 'html' : 'text']: body
            });

            await prisma.emailAccount.update({ where: { id: account.id }, data: { currentIndex: i + 1 } });
            logCallback(`✅ [${account.email}] → ${recipient.email}`);
            await delay(Math.floor(Math.random() * (config.delayRange.max - config.delayRange.min + 1) + config.delayRange.min) * 1000);

            await transporter.close();
        } catch (err: any) {
            logCallback(`❌ Ошибка [${account.email}]: ${err.message}`);
            if (err.message.includes('Authentication')) break;
            await delay(5000);
        }
    }
}