import { Bot, session } from 'grammy';
import { Menu } from '@grammyjs/menu';
import { prisma } from './db.js';
import { runMailing } from './mailer.js';
import dotenv from 'dotenv';
dotenv.config();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
bot.use(session({ initial: () => ({ step: 'IDLE', selectedDelay: { min: 15, max: 20 } }) }));
async function clearLastBotMessage(ctx) {
    if (ctx.session.lastBotMessageId) {
        try {
            await ctx.api.deleteMessage(ctx.chat.id, ctx.session.lastBotMessageId);
        }
        catch (e) { }
        ctx.session.lastBotMessageId = undefined;
    }
}
let mainMenu;
let gmailMenu;
let delayMenu;
let accountActionMenu;
let templateMenu;
accountActionMenu = new Menu('account-action')
    .text("📂 Загрузить CSV", async (ctx) => {
    ctx.session.step = 'WAITING_CSV_UPLOAD';
    await ctx.editMessageText("📥 Отправьте `.csv` файл со списком клиентов-получателей для этой почты.");
})
    .text("🗑 Удалить CSV", async (ctx) => {
    await prisma.emailAccount.update({
        where: { id: ctx.session.currentEditingAccountId },
        data: { csvName: null, recipients: null, currentIndex: 0 }
    });
    await ctx.answerCallbackQuery().catch(() => { });
    await ctx.editMessageText("🗑 CSV файл успешно удален, список получателей очищен.", { reply_markup: accountActionMenu });
})
    .row()
    .text("❌ УДАЛИТЬ ПОЧТУ ИЗ СИСТЕМЫ", async (ctx) => {
    const id = ctx.session.currentEditingAccountId;
    if (id) {
        const deleted = await prisma.emailAccount.delete({ where: { id } });
        await ctx.reply(`🗑 Почтовый ящик ${deleted.email} полностью удален.`);
    }
    await ctx.answerCallbackQuery().catch(() => { });
    ctx.menu.back();
})
    .row()
    .text("⬅️ Назад", (ctx) => ctx.menu.back());
gmailMenu = new Menu('gmail-management')
    .dynamic(async (ctx, range) => {
    const userId = String(ctx.from?.id);
    const accounts = await prisma.emailAccount.findMany({ where: { telegramId: userId } });
    if (accounts.length === 0) {
        range.text("Кабинет пуст. Добавьте почту 👇");
        range.row();
    }
    for (const account of accounts) {
        const statusIndicator = account.isActive ? "🟢" : "🔴";
        const csvIndicator = account.recipients ? "📄 CSV" : "⚠️ Без CSV";
        range.text(`${statusIndicator} ${account.email.split('@')[0]}... | ${csvIndicator}`, async (ctx) => {
            ctx.session.currentEditingAccountId = account.id;
            await ctx.editMessageText(`⚙️ **Управление аккаунтом:**\n\nПочта: \`${account.email}\`\nФайл получателей: \`${account.csvName || 'Не загружен'}\``, {
                parse_mode: 'Markdown',
                reply_markup: accountActionMenu
            });
        });
        range.text(account.isActive ? "⏸ Выкл" : "▶️ Вкл", async (ctx) => {
            await prisma.emailAccount.update({ where: { id: account.id }, data: { isActive: !account.isActive } });
            await ctx.answerCallbackQuery().catch(() => { });
            ctx.menu.update();
        });
        range.row();
    }
})
    .text("➕ Добавить аккаунт Gmail", async (ctx) => {
    ctx.session.step = 'WAITING_EMAIL_ADD';
    const msg = await ctx.reply("📧 Отправьте данные аккаунта в формате:\n`your-email@gmail.com пароль_приложения` (через один пробел)", { parse_mode: 'Markdown' });
    ctx.session.lastBotMessageId = msg.message_id;
})
    .row()
    .text("⬅️ Назад", (ctx) => ctx.menu.back());
delayMenu = new Menu('delay-menu')
    .text(async (ctx) => `15-20 сек ${ctx.session.selectedDelay.min === 15 ? '✅' : ''}`, async (ctx) => {
    ctx.session.selectedDelay = { min: 15, max: 20 };
    await ctx.answerCallbackQuery().catch(() => { });
    ctx.menu.update();
})
    .text(async (ctx) => `20-35 сек ${ctx.session.selectedDelay.min === 20 ? '✅' : ''}`, async (ctx) => {
    ctx.session.selectedDelay = { min: 20, max: 35 };
    await ctx.answerCallbackQuery().catch(() => { });
    ctx.menu.update();
})
    .text(async (ctx) => `35-60 сек ${ctx.session.selectedDelay.min === 35 ? '✅' : ''}`, async (ctx) => {
    ctx.session.selectedDelay = { min: 35, max: 60 };
    await ctx.answerCallbackQuery().catch(() => { });
    ctx.menu.update();
})
    .row()
    .text("⬅️ Назад в меню", (ctx) => ctx.menu.back());
templateMenu = new Menu('template-menu')
    .text("📝 Текстовый шаблон (Subject + Text)", async (ctx) => {
    ctx.session.step = 'WAITING_TEXT_TEMPLATE';
    const msg = await ctx.reply("📝 Режим текста.\n\nОтправьте Тему и Текст через разделитель `//`:\n\n*Пример:* `Скидка 50% // Здравствуйте!`", { parse_mode: 'Markdown' });
    ctx.session.lastBotMessageId = msg.message_id;
})
    .row()
    .text("🔥 HTML шаблон (Subject + Файл)", async (ctx) => {
    ctx.session.step = 'WAITING_HTML_SUBJECT';
    const msg = await ctx.reply("🔥 Режим HTML макета.\n\n*Шаг 1:* Напишите и отправьте текстом **Тему письма** для вашего HTML файла:", { parse_mode: 'Markdown' });
    ctx.session.lastBotMessageId = msg.message_id;
})
    .row()
    .text("⬅️ Назад", (ctx) => ctx.menu.back());
// --- ГЛАВНОЕ МЕНЮ ---
mainMenu = new Menu('main-menu')
    .text("📬 Мой кабинет (Gmail)", async (ctx) => {
    await ctx.editMessageText("📂 Список ваших личных подключенных ящиков:", { reply_markup: gmailMenu });
})
    .row()
    .text("⚙️ Настройка шаблона письма", async (ctx) => {
    await ctx.editMessageText("Выберите тип шаблона для массовой рассылки:", { reply_markup: templateMenu });
})
    .row()
    .text("📝 Настройка задержки", (ctx) => ctx.reply("Выберите диапазон умного рандома для таймингов отправки писем:", { reply_markup: delayMenu }))
    .row()
    .text("📈 СТАТИСТИКА РАССЫЛКИ", async (ctx) => {
    const successCount = await prisma.log.count({ where: { status: 'SUCCESS' } });
    const errorCount = await prisma.log.count({ where: { status: 'ERROR' } });
    const accounts = await prisma.emailAccount.findMany();
    let activeProgressText = "";
    for (const acc of accounts) {
        if (acc.recipients) {
            const total = acc.recipients.split(',').length;
            activeProgressText += `\n📧 \`${acc.email}\`: обработано ${acc.currentIndex} из ${total}`;
        }
    }
    await ctx.reply(`📊 **Общая статистика системы:**\n\n✅ Успешно отправлено: *${successCount}*\n❌ Ошибок отправки: *${errorCount}*\n${activeProgressText || '\nПока нет загруженных CSV баз.'}`, { parse_mode: 'Markdown' });
    await ctx.answerCallbackQuery().catch(() => { });
})
    .row()
    .dynamic(async (ctx, range) => {
    const sysState = await prisma.systemState.findUnique({ where: { id: 1 } });
    const isActive = sysState ? sysState.isMailingActive : false;
    if (isActive) {
        range.text("🛑 ОСТАНОВИТЬ ВСЮ РАССЫЛКУ", async (ctx) => {
            await prisma.systemState.update({ where: { id: 1 }, data: { isMailingActive: false } });
            await ctx.answerCallbackQuery("Рассылка останавливается...").catch(() => { });
            ctx.menu.update();
        });
    }
    else {
        range.text("🚀 ЗАПУСТИТЬ ПАРАЛЛЕЛЬНУЮ РАССЫЛКУ", async (ctx) => {
            const template = await prisma.template.findFirst();
            if (!template)
                return ctx.reply("❌ Ошибка запуска. Сначала создайте текстовый или HTML шаблон в настройках.");
            const chatId = ctx.chat.id;
            const messageId = ctx.msg.message_id;
            await ctx.reply("⚡ Инициализация параллельных потоков рассылки...");
            ctx.menu.update();
            runMailing({
                templateName: template.name,
                delayRange: ctx.session.selectedDelay
            }, async (logMessage) => {
                await ctx.api.sendMessage(chatId, logMessage, { parse_mode: 'Markdown' }).catch(() => { });
                // ИСПРАВЛЕНО: Безопасное обновление через официальный метод bot.api
                await ctx.api.editMessageReplyMarkup(chatId, messageId, {
                    reply_markup: mainMenu
                }).catch(() => { });
            });
        });
    }
});
mainMenu.register(gmailMenu);
mainMenu.register(delayMenu);
mainMenu.register(templateMenu);
gmailMenu.register(accountActionMenu);
bot.use(mainMenu);
bot.command('start', async (ctx) => {
    ctx.session.step = 'IDLE';
    try {
        await ctx.deleteMessage();
    }
    catch (e) { }
    await clearLastBotMessage(ctx);
    await ctx.reply("👋 Добро пожаловать в изолированную панель рассылок компании:", { reply_markup: mainMenu });
});
bot.on('message', async (ctx) => {
    const step = ctx.session.step;
    const userId = String(ctx.from.id);
    if (step === 'WAITING_EMAIL_ADD' && ctx.message.text) {
        try {
            await ctx.deleteMessage();
        }
        catch (e) { }
        await clearLastBotMessage(ctx);
        const parts = ctx.message.text.split(' ');
        if (parts.length !== 2) {
            const msg = await ctx.reply("❌ Неверный формат. \nФормат: `email пароль` через один пробел");
            ctx.session.lastBotMessageId = msg.message_id;
            return;
        }
        const [email, password] = parts;
        try {
            await prisma.emailAccount.create({ data: { email, password, telegramId: userId } });
            ctx.session.step = 'IDLE';
            await ctx.reply("✅ Аккаунт успешно добавлен в ваш кабинет!", { reply_markup: mainMenu });
        }
        catch (err) {
            const msg = await ctx.reply(`❌ Ошибка (возможно аккаунт уже добавлен)`);
            ctx.session.lastBotMessageId = msg.message_id;
        }
    }
    else if (step === 'WAITING_TEXT_TEMPLATE' && ctx.message.text) {
        try {
            await ctx.deleteMessage();
        }
        catch (e) { }
        await clearLastBotMessage(ctx);
        const parts = ctx.message.text.split('//');
        if (parts.length !== 2) {
            const msg = await ctx.reply("❌ Неверный формат! Разделяйте через `//`.");
            ctx.session.lastBotMessageId = msg.message_id;
            return;
        }
        const [subject, body] = parts.map(p => p.trim());
        await prisma.template.upsert({
            where: { name: 'default-mailing' },
            update: { type: 'TEXT', subject, body },
            create: { name: 'default-mailing', type: 'TEXT', subject, body }
        });
        ctx.session.step = 'IDLE';
        await ctx.reply(`✅ Текстовый шаблон сохранен!\n\n**Тема:** ${subject}`, { reply_markup: mainMenu });
    }
    else if (step === 'WAITING_HTML_SUBJECT' && ctx.message.text) {
        try {
            await ctx.deleteMessage();
        }
        catch (e) { }
        await clearLastBotMessage(ctx);
        ctx.session.htmlSubject = ctx.message.text.trim();
        ctx.session.step = 'WAITING_HTML_FILE';
        const msg = await ctx.reply(`Тема для HTML утверждена: "${ctx.session.htmlSubject}"\n\n*Шаг 2:* Теперь отправьте файл \`.html\`.`);
        ctx.session.lastBotMessageId = msg.message_id;
    }
    else if (step === 'WAITING_HTML_FILE' && ctx.message.document) {
        try {
            await ctx.deleteMessage();
        }
        catch (e) { }
        await clearLastBotMessage(ctx);
        const doc = ctx.message.document;
        if (!doc.file_name?.endsWith('.html')) {
            const msg = await ctx.reply("❌ Нужен файл формата `.html`.");
            ctx.session.lastBotMessageId = msg.message_id;
            return;
        }
        const file = await ctx.api.getFile(doc.file_id);
        const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(url);
        const htmlContent = await response.text();
        const savedSubject = ctx.session.htmlSubject || "Информационное сообщение";
        await prisma.template.upsert({
            where: { name: 'default-mailing' },
            update: { type: 'HTML', subject: savedSubject, body: htmlContent },
            create: { name: 'default-mailing', type: 'HTML', subject: savedSubject, body: htmlContent }
        });
        ctx.session.step = 'IDLE';
        await ctx.reply(`✅ HTML-шаблон успешно собран!\n\n**Тема:** ${savedSubject}`, { reply_markup: mainMenu });
    }
    else if (step === 'WAITING_CSV_UPLOAD' && ctx.message.document) {
        try {
            await ctx.deleteMessage();
        }
        catch (e) { }
        await clearLastBotMessage(ctx);
        const doc = ctx.message.document;
        if (!doc.file_name?.endsWith('.csv')) {
            const msg = await ctx.reply("❌ Нужен файл с расширением `.csv`.");
            ctx.session.lastBotMessageId = msg.message_id;
            return;
        }
        const file = await ctx.api.getFile(doc.file_id);
        const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(url);
        const textData = await response.text();
        const emailsParsed = textData.split(/[\r\n,;]+/).map(e => e.trim()).filter(e => e.includes('@'));
        if (emailsParsed.length === 0) {
            const msg = await ctx.reply("❌ Внутри файла не найдено валидных адресов.");
            ctx.session.lastBotMessageId = msg.message_id;
            return;
        }
        await prisma.emailAccount.update({
            where: { id: ctx.session.currentEditingAccountId },
            data: { csvName: doc.file_name, recipients: emailsParsed.join(','), currentIndex: 0 }
        });
        ctx.session.step = 'IDLE';
        await ctx.reply(`📄 Список получателей "${doc.file_name}" (${emailsParsed.length} адресов) успешно загружен.`, { reply_markup: mainMenu });
    }
});
bot.catch((err) => {
    const ctx = err.ctx;
    const error = err.error;
    if (error instanceof Error && error.message.includes("message is not modified")) {
        ctx.answerCallbackQuery().catch(() => { });
        return;
    }
    console.error(`❌ Ошибка в работе бота:`, error);
});
bot.api.setMyCommands([
    { command: "start", description: "Запустить / перезагрузить панель управления" }
]).catch(e => console.error("Ошибка установки команд:", e));
bot.start();
console.log("🚀 Бот успешно инициализирован в изолированном режиме.");
