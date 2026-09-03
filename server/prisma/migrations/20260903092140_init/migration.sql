-- CreateEnum
CREATE TYPE "SpaceKind" AS ENUM ('PERSONAL', 'FAMILY');

-- CreateTable
CREATE TABLE "Space" (
    "id" TEXT NOT NULL,
    "kind" "SpaceKind" NOT NULL,
    "currentEpoch" INTEGER NOT NULL DEFAULT 1,
    "nextSeq" BIGINT NOT NULL DEFAULT 0,
    "headChain" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "founderMemberId" TEXT,

    CONSTRAINT "Space_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "colorRef" TEXT NOT NULL,
    "recoveryPubSig" BYTEA NOT NULL,
    "recoveryPubKex" BYTEA NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "deviceShort" TEXT NOT NULL,
    "sigPubRaw" BYTEA NOT NULL,
    "kexPubRaw" BYTEA NOT NULL,
    "attestation" BYTEA NOT NULL,
    "lastSeenSeq" BIGINT NOT NULL DEFAULT 0,
    "lastPushedSeq" BIGINT NOT NULL DEFAULT 0,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Op" (
    "spaceId" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "opId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "deviceShort" TEXT NOT NULL,
    "witness" BYTEA,
    "chain" BYTEA NOT NULL,
    "envelope" BYTEA NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Op_pkey" PRIMARY KEY ("spaceId","seq")
);

-- CreateTable
CREATE TABLE "Epoch" (
    "spaceId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Epoch_pkey" PRIMARY KEY ("spaceId","epoch")
);

-- CreateTable
CREATE TABLE "KeyWrap" (
    "spaceId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "recipientId" TEXT NOT NULL,
    "wrapped" BYTEA NOT NULL,
    "senderDeviceId" TEXT NOT NULL,

    CONSTRAINT "KeyWrap_pkey" PRIMARY KEY ("spaceId","epoch","recipientId","senderDeviceId")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "verifier" BYTEA NOT NULL,
    "wrapSalt" BYTEA NOT NULL,
    "epoch" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PairSession" (
    "rid" TEXT NOT NULL,
    "boxA" BYTEA,
    "boxB" BYTEA,
    "delivery" BYTEA,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "burnedAt" TIMESTAMP(3),

    CONSTRAINT "PairSession_pkey" PRIMARY KEY ("rid")
);

-- CreateTable
CREATE TABLE "Nonce" (
    "deviceShort" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Nonce_pkey" PRIMARY KEY ("deviceShort","nonce")
);

-- CreateTable
CREATE TABLE "RateBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateBucket_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Member_spaceId_removedAt_idx" ON "Member"("spaceId", "removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Member_spaceId_colorRef_key" ON "Member"("spaceId", "colorRef");

-- CreateIndex
CREATE INDEX "Device_memberId_idx" ON "Device"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_spaceId_deviceShort_key" ON "Device"("spaceId", "deviceShort");

-- CreateIndex
CREATE INDEX "Op_spaceId_seq_idx" ON "Op"("spaceId", "seq");

-- CreateIndex
CREATE INDEX "Op_spaceId_deviceShort_idx" ON "Op"("spaceId", "deviceShort");

-- CreateIndex
CREATE UNIQUE INDEX "Op_spaceId_opId_key" ON "Op"("spaceId", "opId");

-- CreateIndex
CREATE INDEX "KeyWrap_recipientId_idx" ON "KeyWrap"("recipientId");

-- CreateIndex
CREATE INDEX "Invite_spaceId_usedAt_revokedAt_idx" ON "Invite"("spaceId", "usedAt", "revokedAt");

-- CreateIndex
CREATE INDEX "PairSession_expiresAt_idx" ON "PairSession"("expiresAt");

-- CreateIndex
CREATE INDEX "Nonce_expiresAt_idx" ON "Nonce"("expiresAt");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Op" ADD CONSTRAINT "Op_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Epoch" ADD CONSTRAINT "Epoch_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KeyWrap" ADD CONSTRAINT "KeyWrap_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;
