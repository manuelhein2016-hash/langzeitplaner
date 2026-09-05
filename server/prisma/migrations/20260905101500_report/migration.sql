-- LZP-1009 second pass — the Report table.
--
-- A SEPARATE MIGRATION, and the one before it is APPLIED TO THE LIVE DATABASE and is not touched.
-- `prisma migrate deploy` applies what is here and creates nothing else; the deployed relay's ten
-- tables keep every byte they hold.
--
-- ADDITIVE ONLY: one CREATE TABLE and two CREATE INDEXes. No ALTER, nothing destructive, no data
-- movement. Rolling it back means removing the one new table and nothing else notices — which is
-- also why the M8 warning about destructive statements does not fire on this file: there are none.
--
-- NO FOREIGN KEY, ON PURPOSE. There is no column to point at a Space, and the absence is the
-- guarantee: it is what keeps "a report can never appear on the family's board" structural rather
-- than careful (Principle 10), and it is why `DELETE FROM "Space"`'s cascade cannot reach here.
-- If a future migration adds a relation from this table to any other, it is reversing a product
-- decision and not tidying a schema — see server/prisma/schema.prisma model Report.
--
-- `prose` is TEXT and readable. That is deliberate, it is the only prose column in this database,
-- and it is stated in the Datenschutz copy (21.3) together with the 90 days that `expiresAt`
-- carries. The 90 is enforced by server/core/store-interface.js (REPORT_RETENTION_DAYS), not by a
-- database DEFAULT: a DEFAULT would be a second place the number lives and a first place it could
-- silently differ from the German copy.

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "prose" TEXT NOT NULL,
    "image" BYTEA,
    "signed" BOOLEAN NOT NULL,
    "devicePub" BYTEA,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Report_expiresAt_idx" ON "Report"("expiresAt");

-- CreateIndex
CREATE INDEX "Report_receivedAt_idx" ON "Report"("receivedAt");
