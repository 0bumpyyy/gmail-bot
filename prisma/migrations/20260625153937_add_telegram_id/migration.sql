/*
  Warnings:

  - Added the required column `telegramId` to the `EmailAccount` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EmailAccount" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "csvName" TEXT,
    "recipients" TEXT,
    "currentIndex" INTEGER NOT NULL DEFAULT 0,
    "telegramId" TEXT NOT NULL
);
INSERT INTO "new_EmailAccount" ("csvName", "currentIndex", "email", "id", "isActive", "password", "recipients") SELECT "csvName", "currentIndex", "email", "id", "isActive", "password", "recipients" FROM "EmailAccount";
DROP TABLE "EmailAccount";
ALTER TABLE "new_EmailAccount" RENAME TO "EmailAccount";
CREATE UNIQUE INDEX "EmailAccount_email_key" ON "EmailAccount"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
