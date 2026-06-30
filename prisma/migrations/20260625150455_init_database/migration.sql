-- CreateTable
CREATE TABLE "EmailAccount" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "csvName" TEXT,
    "recipients" TEXT,
    "currentIndex" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "HtmlTemplate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "fromEmail" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorMsg" TEXT,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailAccount_email_key" ON "EmailAccount"("email");

-- CreateIndex
CREATE UNIQUE INDEX "HtmlTemplate_name_key" ON "HtmlTemplate"("name");
