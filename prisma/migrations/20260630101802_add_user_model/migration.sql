/*
  Warnings:

  - Added the required column `telegramId` to the `Template` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "telegramId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Template" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "telegramId" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'DEPOP',
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "link" TEXT,
    "subject" TEXT,
    "body" TEXT,
    "senderName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Template" ("body", "createdAt", "id", "name", "subject", "type") SELECT "body", "createdAt", "id", "name", "subject", "type" FROM "Template";
DROP TABLE "Template";
ALTER TABLE "new_Template" RENAME TO "Template";
CREATE INDEX "Template_telegramId_idx" ON "Template"("telegramId");
CREATE UNIQUE INDEX "Template_telegramId_platform_name_key" ON "Template"("telegramId", "platform", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");
