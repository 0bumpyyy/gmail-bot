import { Bot, Context, session, SessionFlavor } from 'grammy';
import { Menu } from '@grammyjs/menu';
import { prisma } from './db.js';
import { runMailing, mailingState } from './mailer.js';
import * as dotenv from 'dotenv';
import { SocksProxyAgent } from 'socks-proxy-agent';


dotenv.config();

type Platform = 'MERCARI_USA' | 'OFFERUP_USA' | 'DEPOP_USA' | 'DEPOP_UK' | 'POSHMARK_USA' | 'BOOKING' | 'ETSY';

interface SessionData {
    step: 'IDLE' | 'WAITING_TOKEN' | 'WAITING_PROXY_ADD' | 'WAITING_EMAIL_ADD' | 'WAITING_JSON_UPLOAD' | 'WAITING_SINGLE_EMAIL' |
        'WAITING_TEXT_NAME' | 'WAITING_TEXT_SUBJECT' | 'WAITING_TEXT_BODY' | 'WAITING_TEXT_SENDER' |
        'WAITING_HTML_NAME' | 'WAITING_HTML_SUBJECT' | 'WAITING_HTML_LINK' | 'WAITING_HTML_FILE' | 'WAITING_HTML_SENDER' | 'WAITING_MANUAL_NAME';
    selectedDelay: { min: number; max: number };
    currentEditingAccountId?: number;
    lastBotMessageId?: number;
    currentPlatform?: Platform;
    currentTemplateName?: string;
    htmlSubject?: string;
    htmlLink?: string;
    textSubject?: string;
    textBody?: string;
    manualPlatform?: Platform;
}
type MyContext = Context & SessionFlavor<SessionData>;

const proxyUrl = process.env.PROXY_URL;
// Создаем агент только если строка не пустая, иначе ставим undefined
const proxyAgent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;

const bot = new Bot<MyContext>(process.env.TELEGRAM_BOT_TOKEN!, {
    client: {
        baseFetchConfig: {
            dispatcher: proxyAgent as any,
            compress: true
        }
    }
});

bot.use(session({ initial: (): SessionData => ({ step: 'IDLE', selectedDelay: { min: 15, max: 20 } }) }));

const platformLabels: Record<Platform, string> = {
    MERCARI_USA:  '🗽 Mercari 🇺🇸',
    OFFERUP_USA:  '📦 OfferUp 🇺🇸',
    DEPOP_USA:    '🎨 Depop 🇺🇸',
    DEPOP_UK:     '🎨 Depop 🇬🇧',
    POSHMARK_USA: '👗 Poshmark 🇺🇸',
    BOOKING:      '🏩 Booking 🇪🇺',
    ETSY:         '🪴 Etsy 🇪🇺'
};

async function deleteMsg(ctx: MyContext, msgId?: number) {
    if (!msgId) return;
    try { await ctx.api.deleteMessage(ctx.chat!.id, msgId); } catch {}
}

async function clearLastBotMessage(ctx: MyContext) {
    if (ctx.session.lastBotMessageId) {
        await deleteMsg(ctx, ctx.session.lastBotMessageId);
        ctx.session.lastBotMessageId = undefined;
    }
}

let mainMenu: Menu<MyContext>;
let gmailMenu: Menu<MyContext>;
let delayMenu: Menu<MyContext>;
let accountActionMenu: Menu<MyContext>;
let templateMenu: Menu<MyContext>;

// ─────────────────────────────────────────────
// ПУЛЬТ УПРАВЛЕНИЯ РАССЫЛКОЙ
// ─────────────────────────────────────────────
const mailingControlMenu = new Menu<MyContext>('mailing-control')
    .text((ctx) => mailingState[String(ctx.from?.id)] === 'RUNNING' ? "⏸  Пауза" : "▶️  Продолжить", async (ctx) => {
        const userId = String(ctx.from?.id);
        if (mailingState[userId] === 'RUNNING') {
            mailingState[userId] = 'PAUSED';
            await ctx.reply("⏸  Рассылка на паузе.");
        } else if (mailingState[userId] === 'PAUSED') {
            mailingState[userId] = 'RUNNING';
            await ctx.reply("▶️  Рассылка возобновлена.");
        }
        ctx.menu.update();
    })
    .text("🛑  Остановить", async (ctx) => {
        const userId = String(ctx.from?.id);
        mailingState[userId] = 'STOPPED';
        await ctx.reply("🛑  Рассылка остановлена.");
        await ctx.menu.close();
    });

// ─────────────────────────────────────────────
// УПРАВЛЕНИЕ АККАУНТОМ
// ─────────────────────────────────────────────
accountActionMenu = new Menu<MyContext>('account-action')
    .text("📂  Загрузить JSON", async (ctx) => {
        ctx.session.step = 'WAITING_JSON_UPLOAD';
        await ctx.editMessageText(
            "📥 Отправьте `.json` файл.\n\nФормат:\n`[{\"email\":\"user@mail.com\",\"name\":\"John\"}, ...]`",
            { parse_mode: 'Markdown' }
        );
    })
    .text("✏️  Один Email", async (ctx) => {
        ctx.session.step = 'WAITING_SINGLE_EMAIL';
        await ctx.editMessageText("✏️ Введите Email адрес получателя:");
    })
    .row()
    .text("🗑  Очистить базу", async (ctx) => {
        await prisma.emailAccount.update({
            where: { id: ctx.session.currentEditingAccountId },
            data: { csvName: null, recipients: null, currentIndex: 0 }
        });
        await ctx.answerCallbackQuery().catch(() => {});
        await ctx.editMessageText("🗑  База получателей очищена.", { reply_markup: accountActionMenu });
    })
    .text("❌  Удалить ящик", async (ctx) => {
        const id = ctx.session.currentEditingAccountId;
        if (id) {
            const deleted = await prisma.emailAccount.delete({ where: { id } });
            await ctx.reply(`🗑  Ящик \`${deleted.email}\` удалён.`, { parse_mode: 'Markdown' });
        }
        await ctx.answerCallbackQuery().catch(() => {});
        ctx.menu.back();
    })
    .row()
    .text("⬅️  Назад", (ctx) => ctx.menu.back());

// ─────────────────────────────────────────────
// КАБИНЕТ GMAIL
// ─────────────────────────────────────────────
gmailMenu = new Menu<MyContext>('gmail-management')
    .dynamic(async (ctx, range) => {
        const userId = String(ctx.from?.id);
        const accounts = await prisma.emailAccount.findMany({ where: { telegramId: userId } });

        if (accounts.length === 0) {
            range.text("〰️  Кабинет пуст — добавьте почту");
            range.row();
        }

        for (const account of accounts) {
            const status = account.isActive ? "🟢" : "🔴";
            const base = account.recipients ? "📄" : "⚠️";
            const shortEmail = account.email.split('@')[0];

            range.text(`${status}  ${shortEmail}  ${base}`, async (ctx) => {
                ctx.session.currentEditingAccountId = account.id;
                let recipientsInfo = 'Не загружены';
                if (account.recipients) {
                    try {
                        const parsed = JSON.parse(account.recipients);
                        recipientsInfo = `${account.csvName} (${parsed.length} чел.)`;
                    } catch { recipientsInfo = account.csvName || 'Загружены'; }
                }
                await ctx.editMessageText(
                    `⚙️ *Управление аккаунтом*\n\n📧 \`${account.email}\`\n👥 База: \`${recipientsInfo}\`\n📍 Прогресс: ${account.currentIndex} отправлено`,
                    { parse_mode: 'Markdown', reply_markup: accountActionMenu }
                );
            });

            range.text(account.isActive ? "⏸  Выкл" : "▶️  Вкл", async (ctx) => {
                await prisma.emailAccount.update({ where: { id: account.id }, data: { isActive: !account.isActive } });
                await ctx.answerCallbackQuery().catch(() => {});
                ctx.menu.update();
            });
            range.row();
        }
    })
    .text("➕  Добавить Gmail аккаунт", async (ctx) => {
        ctx.session.step = 'WAITING_EMAIL_ADD';
        const msg = await ctx.reply(
            "📧 Отправьте данные в формате:\n`email@gmail.com пароль_приложения`",
            { parse_mode: 'Markdown' }
        );
        ctx.session.lastBotMessageId = msg.message_id;
    })
    .row()
    .text("⬅️  Назад", (ctx) => ctx.menu.back());

// ─────────────────────────────────────────────
// ЗАДЕРЖКА
// ─────────────────────────────────────────────
delayMenu = new Menu<MyContext>('delay-menu')
    .text(async (ctx) => `${ctx.session.selectedDelay.min === 15 ? '✅' : ''}  15–20 сек`, async (ctx) => {
        ctx.session.selectedDelay = { min: 15, max: 20 };
        await ctx.answerCallbackQuery().catch(() => {});
        ctx.menu.update();
    })
    .text(async (ctx) => `${ctx.session.selectedDelay.min === 20 ? '✅' : ''}  20–35 сек`, async (ctx) => {
        ctx.session.selectedDelay = { min: 20, max: 35 };
        await ctx.answerCallbackQuery().catch(() => {});
        ctx.menu.update();
    })
    .text(async (ctx) => `${ctx.session.selectedDelay.min === 35 ? '✅' : ''}  35–60 сек`, async (ctx) => {
        ctx.session.selectedDelay = { min: 35, max: 60 };
        await ctx.answerCallbackQuery().catch(() => {});
        ctx.menu.update();
    })
    .row()
    .text("⬅️  Назад", (ctx) => ctx.menu.back());

// ─────────────────────────────────────────────
// ТЕКСТОВЫЕ ШАБЛОНЫ — СПИСОК
// ─────────────────────────────────────────────
const textTemplatesListMenu = new Menu<MyContext>('text-templates-list')
    .dynamic(async (ctx, range) => {
        const userId = String(ctx.from?.id);
        const platform = ctx.session.currentPlatform || 'DEPOP_USA';
        const templates = await prisma.template.findMany({ where: { telegramId: userId, type: 'TEXT', platform } });

        if (templates.length === 0) {
            range.text("〰️  Шаблонов нет — создайте первый");
            range.row();
        }

        for (const t of templates) {
            const active = t.isActive ? "✅  " : "　　";
            range.text(`${active}${t.name}`, async (ctx) => {
                await prisma.template.updateMany({ where: { telegramId: userId }, data: { isActive: false } });
                await prisma.template.update({ where: { id: t.id }, data: { isActive: true } });
                await ctx.answerCallbackQuery(`✅ Активен: ${t.name}`).catch(() => {});
                ctx.menu.update();
            });
            range.text("🗑", async (ctx) => {
                await prisma.template.delete({ where: { id: t.id } });
                await ctx.answerCallbackQuery(`Удалено: ${t.name}`).catch(() => {});
                ctx.menu.update();
            });
            range.row();
        }
    })
    .text("➕  Создать текстовый шаблон", async (ctx) => {
        ctx.session.step = 'WAITING_TEXT_NAME';
        const msg = await ctx.reply("✍️ *Шаг 1 из 4* — Введите название шаблона:", { parse_mode: 'Markdown' });
        ctx.session.lastBotMessageId = msg.message_id;
    })
    .row()
    .text("⬅️  Назад", async (ctx) => {
        const isUK = ctx.session.currentPlatform?.endsWith('_UK');
        if (isUK) {
            await ctx.editMessageText("🇬🇧 Выберите платформу:", { reply_markup: textPlatformsUKMenu });
        } else {
            await ctx.editMessageText("🇺🇸 Выберите платформу:", { reply_markup: textPlatformsUSAMenu });
        }
    });

// ─────────────────────────────────────────────
// ТЕКСТОВЫЕ ШАБЛОНЫ — США
// ─────────────────────────────────────────────
const textPlatformsUSAMenu = new Menu<MyContext>('text-platforms-usa')
    .text("🗽  Mercari", async (ctx) => {
        ctx.session.currentPlatform = 'MERCARI_USA';
        await ctx.editMessageText("📋 Текстовые шаблоны — *Mercari 🇺🇸*", { parse_mode: 'Markdown', reply_markup: textTemplatesListMenu });
    })
    .text("📦  OfferUp", async (ctx) => {
        ctx.session.currentPlatform = 'OFFERUP_USA';
        await ctx.editMessageText("📋 Текстовые шаблоны — *OfferUp 🇺🇸*", { parse_mode: 'Markdown', reply_markup: textTemplatesListMenu });
    })
    .row()
    .text("🎨  Depop", async (ctx) => {
        ctx.session.currentPlatform = 'DEPOP_USA';
        await ctx.editMessageText("📋 Текстовые шаблоны — *Depop 🇺🇸*", { parse_mode: 'Markdown', reply_markup: textTemplatesListMenu });
    })
    .text("👗  Poshmark", async (ctx) => {
        ctx.session.currentPlatform = 'POSHMARK_USA';
        await ctx.editMessageText("📋 Текстовые шаблоны — *Poshmark 🇺🇸*", { parse_mode: 'Markdown', reply_markup: textTemplatesListMenu });
    })
    .row()
    .text("⬅️  Назад", async (ctx) => {
        await ctx.editMessageText("🌍 Выберите регион:", { reply_markup: textPlatformsMenu });
    });

// ─────────────────────────────────────────────
// ТЕКСТОВЫЕ ШАБЛОНЫ — UK
// ─────────────────────────────────────────────
const textPlatformsUKMenu = new Menu<MyContext>('text-platforms-uk')
    .text("🎨  Depop", async (ctx) => {
        ctx.session.currentPlatform = 'DEPOP_UK';
        await ctx.editMessageText("📋 Текстовые шаблоны — *Depop 🇬🇧*", { parse_mode: 'Markdown', reply_markup: textTemplatesListMenu });
    })
    .text("🏩  Booking PARSE", async (ctx) => {
        ctx.session.currentPlatform = 'BOOKING';
        await ctx.editMessageText("📋 Текстовые шаблоны — *Booking 🇪🇺*", { parse_mode: 'Markdown', reply_markup: textTemplatesListMenu });
    })
    .row()
    .text("🪴  ETSY", async (ctx) => {
        ctx.session.currentPlatform = 'ETSY';
        await ctx.editMessageText("📋 Текстовые шаблоны — *Etsy 🇪🇺*", { parse_mode: 'Markdown', reply_markup: textTemplatesListMenu });
    })
    .row()
    .text("⬅️  Назад", async (ctx) => {
        await ctx.editMessageText("🌍 Выберите регион:", { reply_markup: textPlatformsMenu });
    });

// ─────────────────────────────────────────────
// ТЕКСТОВЫЕ ШАБЛОНЫ — РЕГИОН
// ─────────────────────────────────────────────
const textPlatformsMenu = new Menu<MyContext>('text-platforms')
    .text("🇺🇸  США", async (ctx) => {
        await ctx.editMessageText("🇺🇸 Выберите платформу:", { reply_markup: textPlatformsUSAMenu });
    })
    .text("🇪🇺  EU", async (ctx) => {
        await ctx.editMessageText("🇪🇺 Выберите платформу:", { reply_markup: textPlatformsUKMenu });
    })
    .row()
    .text("⬅️  Назад", async (ctx) => {
        await ctx.editMessageText("📋 Выберите тип шаблона:", { reply_markup: templateMenu });
    });

// ─────────────────────────────────────────────
// HTML ШАБЛОНЫ — СПИСОК
// ─────────────────────────────────────────────
const htmlTemplatesListMenu = new Menu<MyContext>('html-templates-list')
    .dynamic(async (ctx, range) => {
        const userId = String(ctx.from?.id);
        const platform = ctx.session.currentPlatform || 'DEPOP_USA';
        const templates = await prisma.template.findMany({ where: { telegramId: userId, type: 'HTML', platform } });

        if (templates.length === 0) {
            range.text("〰️  Шаблонов нет — создайте первый");
            range.row();
        }

        for (const t of templates) {
            const active = t.isActive ? "✅  " : "　　";
            range.text(`${active}${t.name}`, async (ctx) => {
                await prisma.template.updateMany({ where: { telegramId: userId }, data: { isActive: false } });
                await prisma.template.update({ where: { id: t.id }, data: { isActive: true } });
                await ctx.answerCallbackQuery(`✅ Активен: ${t.name}`).catch(() => {});
                ctx.menu.update();
            });
            range.text("🗑", async (ctx) => {
                await prisma.template.delete({ where: { id: t.id } });
                await ctx.answerCallbackQuery(`Удалено: ${t.name}`).catch(() => {});
                ctx.menu.update();
            });
            range.row();
        }
    })
    .text("➕  Создать HTML шаблон", async (ctx) => {
        ctx.session.step = 'WAITING_HTML_NAME';  // HTML, а не TEXT
        const msg = await ctx.reply("✍️ *Шаг 1 из 5* — Введите название HTML шаблона:", { parse_mode: 'Markdown' });
        ctx.session.lastBotMessageId = msg.message_id;
    })
    .row()
    .text("⬅️  Назад", async (ctx) => {
        const isUK = ctx.session.currentPlatform?.endsWith('_UK');
        if (isUK) {
            await ctx.editMessageText("🇬🇧 Выберите платформу:", { reply_markup: htmlPlatformsUKMenu });
        } else {
            await ctx.editMessageText("🇺🇸 Выберите платформу:", { reply_markup: htmlPlatformsUSAMenu });
        }
    });

// ─────────────────────────────────────────────
// HTML ШАБЛОНЫ — США
// ─────────────────────────────────────────────
const htmlPlatformsUSAMenu = new Menu<MyContext>('html-platforms-usa')
    .text("🗽  Mercari", async (ctx) => {
        ctx.session.currentPlatform = 'MERCARI_USA';
        await ctx.editMessageText("📋 HTML шаблоны — *Mercari 🇺🇸*", { parse_mode: 'Markdown', reply_markup: htmlTemplatesListMenu });
    })
    .text("📦  OfferUp", async (ctx) => {
        ctx.session.currentPlatform = 'OFFERUP_USA';
        await ctx.editMessageText("📋 HTML шаблоны — *OfferUp 🇺🇸*", { parse_mode: 'Markdown', reply_markup: htmlTemplatesListMenu });
    })
    .row()
    .text("🎨  Depop", async (ctx) => {
        ctx.session.currentPlatform = 'DEPOP_USA';
        await ctx.editMessageText("📋 HTML шаблоны — *Depop 🇺🇸*", { parse_mode: 'Markdown', reply_markup: htmlTemplatesListMenu });
    })
    .text("👗  Poshmark", async (ctx) => {
        ctx.session.currentPlatform = 'POSHMARK_USA';
        await ctx.editMessageText("📋 HTML шаблоны — *Poshmark 🇺🇸*", { parse_mode: 'Markdown', reply_markup: htmlTemplatesListMenu });
    })
    .row()
    .text("⬅️  Назад", async (ctx) => {
        await ctx.editMessageText("🌍 Выберите регион:", { reply_markup: htmlPlatformsMenu });
    });

// ─────────────────────────────────────────────
// HTML ШАБЛОНЫ — UK
// ─────────────────────────────────────────────
const htmlPlatformsUKMenu = new Menu<MyContext>('html-platforms-uk')
    .text("🎨  Depop", async (ctx) => {
        ctx.session.currentPlatform = 'DEPOP_UK';
        await ctx.editMessageText("📋 HTML шаблоны — *Depop 🇬🇧*", { parse_mode: 'Markdown', reply_markup: htmlTemplatesListMenu });
    })
    .text("🏩 Booking PARSE", async (ctx) => {
        ctx.session.currentPlatform = 'BOOKING';
        await ctx.editMessageText("📋 Текстовые шаблоны — *Booking 🇪🇺*", { parse_mode: 'Markdown', reply_markup: textTemplatesListMenu });
    })
    .row()
    .text("🪴  ETSY", async (ctx) => {
        ctx.session.currentPlatform = 'ETSY';
        await ctx.editMessageText("📋 Текстовые шаблоны — *Etsy 🇪🇺*", { parse_mode: 'Markdown', reply_markup: textTemplatesListMenu });
    })
    .row()
    .text("⬅️  Назад", async (ctx) => {
        await ctx.editMessageText("🌍 Выберите регион:", { reply_markup: htmlPlatformsMenu });
    });

// ─────────────────────────────────────────────
// HTML ШАБЛОНЫ — РЕГИОН
// ─────────────────────────────────────────────
const htmlPlatformsMenu = new Menu<MyContext>('html-platforms')
    .text("🇺🇸  США", async (ctx) => {
        await ctx.editMessageText("🇺🇸 Выберите платформу:", { reply_markup: htmlPlatformsUSAMenu });
    })
    .text("🇪🇺  EU", async (ctx) => {
        await ctx.editMessageText("🇬🇧 Выберите платформу:", { reply_markup: htmlPlatformsUKMenu });
    })
    .row()
    .text("⬅️  Назад", async (ctx) => {
        await ctx.editMessageText("📋 Выберите тип шаблона:", { reply_markup: templateMenu });
    });

// ─────────────────────────────────────────────
// РУЧНАЯ ГЕНЕРАЦИЯ — ПЛАТФОРМЫ США
// ─────────────────────────────────────────────
const genPlatformsUSAMenu = new Menu<MyContext>('gen-platforms-usa')
    .text("🗽  Mercari VRF", async (ctx) => {
        ctx.session.manualPlatform = 'MERCARI_USA';
        ctx.session.step = 'WAITING_MANUAL_NAME';
        await ctx.editMessageText("✏️ Введите имя получателя для *Mercari 🇺🇸*:", { parse_mode: 'Markdown' });
    })
    .text("📦  OfferUp VRF", async (ctx) => {
        ctx.session.manualPlatform = 'OFFERUP_USA';
        ctx.session.step = 'WAITING_MANUAL_NAME';
        await ctx.editMessageText("✏️ Введите имя получателя для *OfferUp 🇺🇸*:", { parse_mode: 'Markdown' });
    })
    .row()
    .text("🎨  Depop VRF", async (ctx) => {
        ctx.session.manualPlatform = 'DEPOP_USA';
        ctx.session.step = 'WAITING_MANUAL_NAME';
        await ctx.editMessageText("✏️ Введите имя получателя для *Depop 🇺🇸*:", { parse_mode: 'Markdown' });
    })
    .text("👗  Poshmark VRF", async (ctx) => {
        ctx.session.manualPlatform = 'POSHMARK_USA';
        ctx.session.step = 'WAITING_MANUAL_NAME';
        await ctx.editMessageText("✏️ Введите имя получателя для *Poshmark 🇺🇸*:", { parse_mode: 'Markdown' });
    })
    .row()
    .text("⬅️  Назад", async (ctx) => {
        await ctx.editMessageText("🌍 Выберите регион:", { reply_markup: genPlatformsMenu });
    });

// ─────────────────────────────────────────────
// РУЧНАЯ ГЕНЕРАЦИЯ — ПЛАТФОРМЫ UK
// ─────────────────────────────────────────────
const genPlatformsUKMenu = new Menu<MyContext>('gen-platforms-uk')
    .text("🎨  Depop VRF", async (ctx) => {
        ctx.session.manualPlatform = 'DEPOP_UK';
        ctx.session.step = 'WAITING_MANUAL_NAME';
        await ctx.editMessageText("✏️ Введите имя получателя для *Depop 🇬🇧*:", { parse_mode: 'Markdown' });
    })
    .text("🏩  Booking PARSE 🇪🇺", async (ctx) => {
    ctx.session.manualPlatform = 'BOOKING';
    ctx.session.step = 'WAITING_MANUAL_NAME';
    await ctx.editMessageText("✏️ Введите имя получателя для *BOOKING *:", { parse_mode: 'Markdown' });
})
    .row()
    .text("🪴 Etsy VRF", async (ctx) => {
        ctx.session.manualPlatform = 'ETSY';
        ctx.session.step = 'WAITING_MANUAL_NAME';
        await ctx.editMessageText("✏️ Введите имя получателя для *ETSY 🇪🇺*:", { parse_mode: 'Markdown' });
    })
    .row()
    .text("⬅️  Назад", async (ctx) => {
        await ctx.editMessageText("🌍 Выберите регион:", { reply_markup: genPlatformsMenu });
    });

// ─────────────────────────────────────────────
// РУЧНАЯ ГЕНЕРАЦИЯ — РЕГИОН
// ─────────────────────────────────────────────
const genPlatformsMenu = new Menu<MyContext>('gen-platforms')
    .text("🇺🇸  США", async (ctx) => {
        await ctx.editMessageText("🇺🇸 Выберите платформу:", { reply_markup: genPlatformsUSAMenu });
    })
    .text("🇪🇺  EU", async (ctx) => {
        await ctx.editMessageText("🇬🇧 Выберите платформу:", { reply_markup: genPlatformsUKMenu });
    })
    .row()
    .text("⬅️  Назад", async (ctx) => {
        await ctx.editMessageText("👋 *Панель управления рассылками*\n\nВыберите действие:", { parse_mode: 'Markdown', reply_markup: mainMenu });
    });


// ─────────────────────────────────────────────
// МЕНЮ ШАБЛОНОВ
// ─────────────────────────────────────────────
templateMenu = new Menu<MyContext>('template-menu')
    .text("📝  Текстовые шаблоны", async (ctx) => {
        await ctx.editMessageText("🌍 Выберите регион:", { reply_markup: textPlatformsMenu });
    })
    .text("🔥  HTML шаблоны", async (ctx) => {
        await ctx.editMessageText("🌍 Выберите регион:", { reply_markup: htmlPlatformsMenu });
    })
    .row()
    .text("⬅️  Назад", (ctx) => ctx.menu.back());

// ─────────────────────────────────────────────
// МЕНЮ ДЕЙСТВИЙ С ПРОКСИ
// ─────────────────────────────────────────────
const proxyActionMenu = new Menu<MyContext>('proxy-action')
    .text("✏️ Изменить", async (ctx) => {
        ctx.session.step = 'WAITING_PROXY_ADD';
        await ctx.editMessageText("🔑 Введите новый прокси в формате `socks5://user:pass@ip:port`:", { parse_mode: 'Markdown' });
    })
    .text("🗑 Удалить", async (ctx) => {
        const userId = String(ctx.from?.id);
        await prisma.user.update({ where: { telegramId: userId }, data: { proxy: null } });
        await ctx.answerCallbackQuery("✅ Прокси удален");
        // Возвращаем в главное меню после удаления
        await ctx.editMessageText("👋 *Панель управления рассылками*\n\nВыберите действие:", { parse_mode: 'Markdown', reply_markup: mainMenu });
    })
    .row()
    .text("⬅️ Назад", (ctx) => ctx.menu.back());

// ─────────────────────────────────────────────
// ГЛАВНОЕ МЕНЮ
// ─────────────────────────────────────────────
mainMenu = new Menu<MyContext>('main-menu')
    .text("📬  Мой кабинет", async (ctx) => {
        await ctx.editMessageText("📂 *Подключённые ящики:*", { parse_mode: 'Markdown', reply_markup: gmailMenu });
    })
    .row()
    .text("✉️  Шаблоны", async (ctx) => {
        await ctx.editMessageText("📋 Выберите тип шаблона:", { reply_markup: templateMenu });
    })
    .text("⏱  Задержка", async (ctx) => {
        const d = ctx.session.selectedDelay;
        await ctx.reply(`⏱ Текущая задержка: *${d.min}–${d.max} сек*\nВыберите новый диапазон:`, { parse_mode: 'Markdown', reply_markup: delayMenu });
        await ctx.answerCallbackQuery().catch(() => {});
    })
    .row()
    .dynamic(async (ctx, range) => {
        const currentWorkerId = String(ctx.from?.id);
        const user = await prisma.user.findUnique({ where: { telegramId: currentWorkerId } });

        if (user?.proxy) {
            range.text("🌐 Прокси: ✅ Настроен", async (ctx) => {
                await ctx.editMessageText(
                    `🌐 *Ваш текущий прокси:*\n\`${user.proxy}\`\n\nВыберите действие:`,
                    { parse_mode: 'Markdown', reply_markup: proxyActionMenu }
                );
            });
        } else {
            range.text("🌐 PROXY", async (ctx) => {
                ctx.session.step = 'WAITING_PROXY_ADD';
                await ctx.editMessageText("🔑 Введите прокси в формате `socks5://user:pass@ip:port`:", { parse_mode: 'Markdown' });
            });
        }
    })
    .text("📊  Статистика", async (ctx) => {
        const userId = String(ctx.from?.id);
        const userAccounts = await prisma.emailAccount.findMany({ where: { telegramId: userId } });
        const userEmails = userAccounts.map(a => a.email);

        const successCount = await prisma.log.count({ where: { status: 'SUCCESS', fromEmail: { in: userEmails } } });
        const errorCount = await prisma.log.count({ where: { status: 'ERROR', fromEmail: { in: userEmails } } });

        let progressText = "";
        for (const acc of userAccounts) {
            if (acc.recipients) {
                try {
                    const parsed = JSON.parse(acc.recipients);
                    const total = Array.isArray(parsed) ? parsed.length : 0;
                    const pct = total > 0 ? Math.round((acc.currentIndex / total) * 100) : 0;
                    progressText += `\n📧 \`${acc.email.split('@')[0]}\`: ${acc.currentIndex}/${total} (${pct}%)`;
                } catch {
                    progressText += `\n📧 \`${acc.email.split('@')[0]}\`: ошибка чтения базы`;
                }
            }
        }

        await ctx.reply(
            `📊 *Статистика рассылки*\n\n✅ Успешно: *${successCount}*\n❌ Ошибок: *${errorCount}*\n${progressText || '\n_Базы получателей не загружены_'}`,
            { parse_mode: 'Markdown' }
        );
        await ctx.answerCallbackQuery().catch(() => {});
    })
    .row()
    .row()
    .text("🔗  Генерация ссылки", async (ctx) => {
        await ctx.editMessageText("🌍 Выберите регион:", { reply_markup: genPlatformsMenu });
    })
    .row()
    .text("🔑  Управление токеном", async (ctx) => {
        const userId = String(ctx.from?.id);
        const user = await prisma.user.findUnique({ where: { telegramId: userId } });
        await ctx.reply(
            user?.token
                ? `🔑 *Токен установлен*\n\n✅ Ваш токен активен\n\nХотите обновить?`
                : `🔑 *Токен не установлен*\n\n❌ Введите ваш токен API`,
            { parse_mode: 'Markdown' }
        );
        ctx.session.step = 'WAITING_TOKEN';
        const msg = await ctx.reply("📝 Введите ваш личный токен API:");
        ctx.session.lastBotMessageId = msg.message_id;
    })
    .row()
    .dynamic(async (ctx, range) => {
        const userId = String(ctx.from?.id);
        const isActive = mailingState[userId] === 'RUNNING' || mailingState[userId] === 'PAUSED';

        if (isActive) {
            range.text("📡  Управление рассылкой", async (ctx) => {
                await ctx.reply("🎯 Пульт управления:", { reply_markup: mailingControlMenu });
                await ctx.answerCallbackQuery().catch(() => {});
            });
        } else {
            range.text("🚀  Запустить рассылку", async (ctx) => {
                const userId = String(ctx.from?.id);
                const template = await prisma.template.findFirst({ where: { telegramId: userId, isActive: true } });

                if (!template) {
                    return ctx.reply("❌ Нет активного шаблона. Выберите шаблон с галочкой ✅");
                }

                const label = platformLabels[template.platform as Platform] || template.platform;
                const chatId = ctx.chat!.id;

                await ctx.reply(`🚀 Запуск рассылки\n📌 Платформа: *${label}*\n✉️ Шаблон: *${template.name}*`, { parse_mode: 'Markdown' });
                await ctx.reply("📡 Пульт управления:", { reply_markup: mailingControlMenu });
                await ctx.answerCallbackQuery().catch(() => {});

                runMailing(
                    { delayRange: ctx.session.selectedDelay, userId },
                    async (logMessage) => {
                        await ctx.api.sendMessage(chatId, logMessage, { parse_mode: 'Markdown' }).catch(() => {});
                    }
                );
            });
        }
    });

// ─────────────────────────────────────────────
// РЕГИСТРАЦИЯ МЕНЮ
// ─────────────────────────────────────────────
mainMenu.register(gmailMenu);
mainMenu.register(delayMenu);
mainMenu.register(templateMenu);
mainMenu.register(proxyActionMenu);

mainMenu.register(genPlatformsMenu);
genPlatformsMenu.register(genPlatformsUSAMenu);
genPlatformsMenu.register(genPlatformsUKMenu);

templateMenu.register(textPlatformsMenu);
templateMenu.register(htmlPlatformsMenu);

textPlatformsMenu.register(textPlatformsUSAMenu);
textPlatformsMenu.register(textPlatformsUKMenu);
textPlatformsMenu.register(textTemplatesListMenu);

htmlPlatformsMenu.register(htmlPlatformsUSAMenu);
htmlPlatformsMenu.register(htmlPlatformsUKMenu);
htmlPlatformsMenu.register(htmlTemplatesListMenu);

gmailMenu.register(accountActionMenu);

bot.use(mailingControlMenu);
bot.use(mainMenu);

// ─────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────
bot.command('start', async (ctx) => {
    const userId = String(ctx.from?.id);
    const user = await prisma.user.findUnique({ where: { telegramId: userId } });

    if (!user?.token) {
        ctx.session.step = 'WAITING_TOKEN';
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        const msg = await ctx.reply("🔑 *Для начала работы введите ваш личный токен API:*\n\nТокен выдается один раз при регистрации аккаунта на сервисе.", { parse_mode: 'Markdown' });
        ctx.session.lastBotMessageId = msg.message_id;
        return;
    }

    ctx.session.step = 'IDLE';
    try { await ctx.deleteMessage(); } catch(e){}
    await clearLastBotMessage(ctx);
    await ctx.reply(
        "👋 *Панель управления рассылками*\n\nВыберите действие:",
        { parse_mode: 'Markdown', reply_markup: mainMenu }
    );
});

// ─────────────────────────────────────────────
// ОБРАБОТЧИК СООБЩЕНИЙ
// ─────────────────────────────────────────────
bot.on('message', async (ctx) => {
    const step = ctx.session.step;
    const userId = String(ctx.from.id);

    // ── ВВОД ТОКЕНА ────────────────────────────
    if (step === 'WAITING_TOKEN' && ctx.message.text) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        const token = ctx.message.text.trim();

        if (token.length < 10) {
            const msg = await ctx.reply("❌ Токен слишком короткий. Проверьте и попробуйте снова.");
            ctx.session.lastBotMessageId = msg.message_id;
            return;
        }

        await prisma.user.upsert({
            where: { telegramId: userId },
            update: { token },
            create: { telegramId: userId, token }
        });

        ctx.session.step = 'IDLE';
        await ctx.reply("✅ Токен сохранён! Теперь вы готовы к работе.", { reply_markup: mainMenu });
    }

    // ДОБАВЛЕНИЕ ПРОКСИ

    else if (step === 'WAITING_PROXY_ADD' && ctx.message.text) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);

        const proxyInput = ctx.message.text.trim();
        const userId = String(ctx.from.id);

        if (!proxyInput.startsWith('socks5://')) {
            const msg = await ctx.reply("❌ Неверный формат. Используйте `socks5://user:pass@ip:port`", { parse_mode: 'Markdown' });
            ctx.session.lastBotMessageId = msg.message_id;
            return;
        }

        await prisma.user.update({
            where: { telegramId: userId },
            data: { proxy: proxyInput }
        });

        ctx.session.step = 'IDLE';
        await ctx.reply("✅ Прокси успешно сохранен!", { reply_markup: mainMenu });
    }

    // ДОБАВЛЕНИЕ АККАУНТА
    else if (step === 'WAITING_EMAIL_ADD' && ctx.message.text) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        const parts = ctx.message.text.split(' ');
        if (parts.length !== 2) {
            const msg = await ctx.reply("❌ Неверный формат.\nНужно: `email@gmail.com пароль`", { parse_mode: 'Markdown' });
            ctx.session.lastBotMessageId = msg.message_id;
            return;
        }
        const [email, password] = parts;
        try {
            await prisma.emailAccount.create({ data: { email, password, telegramId: userId } });
            ctx.session.step = 'IDLE';
            await ctx.reply("✅ Аккаунт добавлен.", { reply_markup: mainMenu });
        } catch {
            const msg = await ctx.reply("❌ Ошибка — возможно, аккаунт уже добавлен.");
            ctx.session.lastBotMessageId = msg.message_id;
        }
    }

    // ── ТЕКСТОВЫЙ ШАБЛОН ──────────────────────
    else if (step === 'WAITING_TEXT_NAME' && ctx.message.text) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        ctx.session.currentTemplateName = ctx.message.text.trim();
        ctx.session.step = 'WAITING_TEXT_SUBJECT';
        const msg = await ctx.reply(
            `*Шаг 2 из 4* — Введите тему письма (Subject):\n\n_Название: "${ctx.session.currentTemplateName}"_`,
            { parse_mode: 'Markdown' }
        );
        ctx.session.lastBotMessageId = msg.message_id;
    }

    else if (step === 'WAITING_TEXT_SUBJECT' && ctx.message.text) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        ctx.session.textSubject = ctx.message.text.trim();
        ctx.session.step = 'WAITING_TEXT_BODY';
        const msg = await ctx.reply(
            `*Шаг 3 из 4* — Введите текст письма:\n\nДоступные переменные:\n\`{{NAME}}\` — имя получателя\n\`{{LINK}}\` — сгенерированная ссылка\n\`{{ORDER_ID}}\` — случайный номер заказа`,
            { parse_mode: 'Markdown' }
        );
        ctx.session.lastBotMessageId = msg.message_id;
    }

    else if (step === 'WAITING_TEXT_BODY' && ctx.message.text) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        ctx.session.textBody = ctx.message.text.trim();
        ctx.session.step = 'WAITING_TEXT_SENDER';
        const msg = await ctx.reply(
            `*Шаг 4 из 4* — Введите имя отправителя:\n\n_Например: Support, John от Depop_`,
            { parse_mode: 'Markdown' }
        );
        ctx.session.lastBotMessageId = msg.message_id;
    }

    else if (step === 'WAITING_TEXT_SENDER' && ctx.message.text) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        const senderName = ctx.message.text.trim();
        const platform = ctx.session.currentPlatform || 'DEPOP_USA';
        const templateName = ctx.session.currentTemplateName || 'Без названия';

        await prisma.template.updateMany({ where: { telegramId: userId }, data: { isActive: false } });
        await prisma.template.create({
            data: {
                telegramId: userId, platform, name: templateName, type: 'TEXT',
                subject: ctx.session.textSubject, body: ctx.session.textBody,
                senderName, isActive: true
            }
        });

        ctx.session.step = 'IDLE';
        ctx.session.currentTemplateName = undefined;
        ctx.session.textSubject = undefined;
        ctx.session.textBody = undefined;

        const label = platformLabels[platform] || platform;
        await ctx.reply(`✅ Шаблон *"${templateName}"* создан для ${label} и активирован.`, { parse_mode: 'Markdown', reply_markup: mainMenu });
    }

    // ── HTML ШАБЛОН ───────────────────────────
    else if (step === 'WAITING_HTML_NAME' && ctx.message.text) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        ctx.session.currentTemplateName = ctx.message.text.trim();
        ctx.session.step = 'WAITING_HTML_SUBJECT';
        const msg = await ctx.reply(
            `*Шаг 2 из 5* — Введите тему письма (Subject):\n\n_Название: "${ctx.session.currentTemplateName}"_`,
            { parse_mode: 'Markdown' }
        );
        ctx.session.lastBotMessageId = msg.message_id;
    }

    else if (step === 'WAITING_HTML_SUBJECT' && ctx.message.text) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        ctx.session.htmlSubject = ctx.message.text.trim();
        ctx.session.step = 'WAITING_HTML_LINK';
        const msg = await ctx.reply(
            `*Шаг 3 из 5* — Введите резервную ссылку (или точку если не нужна):\n\n_Тема: "${ctx.session.htmlSubject}"_`,
            { parse_mode: 'Markdown' }
        );
        ctx.session.lastBotMessageId = msg.message_id;
    }

    else if (step === 'WAITING_HTML_LINK' && ctx.message.text) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        ctx.session.htmlLink = ctx.message.text.trim();
        ctx.session.step = 'WAITING_HTML_FILE';
        const msg = await ctx.reply(
            `*Шаг 4 из 5* — Отправьте файл \`.html\`\n\nВ коде письма используйте:\n\`{{NAME}}\` \`{{LINK}}\` \`{{ORDER_ID}}\``,
            { parse_mode: 'Markdown' }
        );
        ctx.session.lastBotMessageId = msg.message_id;
    }

    else if (step === 'WAITING_HTML_FILE' && ctx.message.document) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        const doc = ctx.message.document;
        if (!doc.file_name?.endsWith('.html')) {
            const msg = await ctx.reply("❌ Нужен файл `.html`", { parse_mode: 'Markdown' });
            ctx.session.lastBotMessageId = msg.message_id;
            return;
        }
        const file = await ctx.api.getFile(doc.file_id);
        const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(url);
        ctx.session.textBody = await response.text();
        ctx.session.step = 'WAITING_HTML_SENDER';
        const msg = await ctx.reply("*Шаг 5 из 5* — Введите имя отправителя:", { parse_mode: 'Markdown' });
        ctx.session.lastBotMessageId = msg.message_id;
    }

    else if (step === 'WAITING_HTML_SENDER' && ctx.message.text) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        const senderName = ctx.message.text.trim();
        const platform = ctx.session.currentPlatform || 'DEPOP_USA';
        const templateName = ctx.session.currentTemplateName || 'Без названия';

        await prisma.template.updateMany({ where: { telegramId: userId }, data: { isActive: false } });
        await prisma.template.create({
            data: {
                telegramId: userId, platform, name: templateName, type: 'HTML',
                subject: ctx.session.htmlSubject || 'Письмо',
                body: ctx.session.textBody || '',
                link: ctx.session.htmlLink || '#',
                senderName, isActive: true
            }
        });

        ctx.session.step = 'IDLE';
        ctx.session.htmlSubject = undefined;
        ctx.session.htmlLink = undefined;
        ctx.session.textBody = undefined;

        const label = platformLabels[platform] || platform;
        await ctx.reply(`✅ HTML шаблон *"${templateName}"* создан для ${label} и активирован.`, { parse_mode: 'Markdown', reply_markup: mainMenu });
    }

    // ── ОДИН EMAIL ────────────────────────────
    else if (step === 'WAITING_SINGLE_EMAIL' && ctx.message.text) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        const targetEmail = ctx.message.text.trim();
        if (!targetEmail.includes('@')) {
            const msg = await ctx.reply("❌ Некорректный Email. Попробуйте ещё раз.");
            ctx.session.lastBotMessageId = msg.message_id;
            return;
        }
        await prisma.emailAccount.update({
            where: { id: ctx.session.currentEditingAccountId },
            data: { csvName: "Вручную (1 адрес)", recipients: JSON.stringify([{ email: targetEmail, name: '' }]), currentIndex: 0 }
        });
        ctx.session.step = 'IDLE';
        await ctx.reply(`✅ Получатель \`${targetEmail}\` установлен.`, { parse_mode: 'Markdown', reply_markup: mainMenu });
    }

    // ── JSON ЗАГРУЗКА ─────────────────────────
    else if (step === 'WAITING_JSON_UPLOAD' && ctx.message.document) {
        try { await ctx.deleteMessage(); } catch(e){}
        await clearLastBotMessage(ctx);
        const doc = ctx.message.document;

        if (!doc.file_name?.endsWith('.json')) {
            const msg = await ctx.reply("❌ Нужен файл `.json`", { parse_mode: 'Markdown' });
            ctx.session.lastBotMessageId = msg.message_id;
            return;
        }

        const file = await ctx.api.getFile(doc.file_id);
        const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(url);
        const textData = await response.text();

        let parsed: { email: string; name: string }[] = [];
        try {
            parsed = JSON.parse(textData);
            if (!Array.isArray(parsed) || !parsed[0]?.email) throw new Error();
        } catch {
            const msg = await ctx.reply(
                '❌ Неверный формат.\nНужно: `[{"email":"...","name":"..."}, ...]`',
                { parse_mode: 'Markdown' }
            );
            ctx.session.lastBotMessageId = msg.message_id;
            return;
        }

        const valid = parsed.filter(r => r.email?.includes('@'));
        if (valid.length === 0) {
            const msg = await ctx.reply("❌ Нет валидных адресов в файле.");
            ctx.session.lastBotMessageId = msg.message_id;
            return;
        }

        await prisma.emailAccount.update({
            where: { id: ctx.session.currentEditingAccountId },
            data: { csvName: doc.file_name, recipients: JSON.stringify(valid), currentIndex: 0 }
        });
        ctx.session.step = 'IDLE';
        await ctx.reply(
            `✅ Загружено *${valid.length}* получателей из \`${doc.file_name}\``,
            { parse_mode: 'Markdown', reply_markup: mainMenu }
        );
    }

    // ── РУЧНАЯ ГЕНЕРАЦИЯ ССЫЛКИ ───────────────
    else if (step === 'WAITING_MANUAL_NAME' && ctx.message.text) {
        try { await ctx.deleteMessage(); } catch(e){}
        const name = ctx.message.text.trim();
        const platform = ctx.session.manualPlatform || 'DEPOP_USA';
        const label = platformLabels[platform] || platform;

        const waitMsg = await ctx.reply("⏳ Генерирую ссылку...");

        try {
            // Получаем Telegram ID воркера, который сейчас генерирует ссылку
            const currentWorkerId = String(ctx.from?.id);

            // Ищем запись этого воркера в PostgreSQL
            const user = await prisma.user.findUnique({ where: { telegramId: currentWorkerId } });
            if (!user?.token) {
                throw new Error('Вы не ввели токен при входе или ваша запись не найдена.');
            }

            const platformToService: Record<string, string> = {
                MERCARI_USA:  'mercari3_usa',
                OFFERUP_USA:  'offerup3_usa',
                DEPOP_USA:    'depop3_usa',
                DEPOP_UK:     'depop3_uk',
                POSHMARK_USA: 'poshmark3_eu',
                ETSY: 'etsy_eu',
                BOOKING: 'booking_eu_parse'
            };

            const response = await fetch('https://api.k7r4q9p2z1x1.cfd/api/protected', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_key: user.token.trim(),    // ✂️ Очищаем токен от случайных пробелов/переносов
                    title: name,
                    service: platformToService[platform],
                    userId: currentWorkerId        // Передаем Telegram ID воркера текстом (например, '9999999')
                })
            });

            const data = await response.json() as any;

            if (data.error || !data.message) {
                throw new Error(data.error || 'Неверный ответ API');
            }

            const fullLink = data.message || '—';
            const shortLink = data.fish_link || fullLink;
            const searchLink = data.search_link || '—';

            try { await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id); } catch {}

            await ctx.reply(
                `🔗 *Ссылка сгенерирована*\n\n` +
                `🏪 Площадка: *${label}*\n` +
                `👤 Имя: *${name}*\n\n` +
                `📎 Основная:\n\`${shortLink}\`\n\n` +
                `✂️ Короткая:\n\`${fullLink}\`\n\n` +
                `🔍 Поиск:\n\`${searchLink}\``,
                { parse_mode: 'Markdown', reply_markup: mainMenu }
            );
        } catch (err: any) {
            try { await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id); } catch {}
            await ctx.reply(`❌ Ошибка: ${err.message}. Проверьте токен в управлении токеном.`, { parse_mode: 'Markdown', reply_markup: mainMenu });
        }

        ctx.session.step = 'IDLE';
        ctx.session.manualPlatform = undefined;
    }
});

// ─────────────────────────────────────────────
// ОБРАБОТЧИК ОШИБОК
// ─────────────────────────────────────────────
bot.catch((err) => {
    const ctx = err.ctx;
    const error = err.error;
    if (error instanceof Error && error.message.includes("message is not modified")) {
        ctx.answerCallbackQuery().catch(() => {});
        return;
    }
    console.error(`❌ Ошибка:`, error);
});

bot.start({
    onStart: async () => {
        console.log("🚀 Бот запущен.");
        await bot.api.setMyCommands([
            { command: "start", description: "Запустить панель управления" }
        ]).catch(e => console.error("Ошибка установки команд:", e));
    }
});