import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";

const DEFAULT_STAGES = ["New Inquiry", "Contacted", "Consultation", "Proposal / Contract", "Active Client"];

export async function prospectStages() {
  const count = await prisma.pipelineStage.count({ where: { pipeline: "PROSPECTS" } });
  if (!count) {
    await prisma.pipelineStage.createMany({
      data: DEFAULT_STAGES.map((name, i) => ({ pipeline: "PROSPECTS", name, position: i, isWon: i === DEFAULT_STAGES.length - 1 })),
    });
  }
  return prisma.pipelineStage.findMany({
    where: { pipeline: "PROSPECTS" },
    orderBy: { position: "asc" },
    include: { cards: { include: { client: { select: { id: true, displayName: true, businessName: true, archivedAt: true } } }, orderBy: { updatedAt: "desc" } } },
  });
}

export async function addProspect(actor: Actor, clientId: string, stageId: string) {
  const existing = await prisma.pipelineCard.findFirst({ where: { clientId, stage: { pipeline: "PROSPECTS" } } });
  if (existing) throw new ValidationError("That client is already in the prospect pipeline.");
  const card = await prisma.pipelineCard.create({ data: { clientId, stageId, ownerId: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "pipeline.added", entityType: "PipelineCard", entityId: card.id, clientId });
}

/** Moving to the "won" stage marks the client Active. */
export async function moveProspect(actor: Actor, cardId: string, stageId: string) {
  const [card, stage] = await Promise.all([prisma.pipelineCard.findUniqueOrThrow({ where: { id: cardId } }), prisma.pipelineStage.findUniqueOrThrow({ where: { id: stageId } })]);
  await prisma.$transaction(async (tx) => {
    await tx.pipelineCard.update({ where: { id: cardId }, data: { stageId } });
    if (stage.isWon) await tx.client.update({ where: { id: card.clientId }, data: { status: "ACTIVE" } });
    await audit(tx, { actorId: actor.id, action: "pipeline.moved", entityType: "PipelineCard", entityId: cardId, clientId: card.clientId, details: { stage: stage.name } });
  });
}

export async function removeProspect(actor: Actor, cardId: string) {
  const card = await prisma.pipelineCard.delete({ where: { id: cardId } });
  await audit(prisma, { actorId: actor.id, action: "pipeline.removed", entityType: "PipelineCard", entityId: cardId, clientId: card.clientId });
}

export async function saveStage(actor: Actor, stageId: string | null, name: string) {
  assertAdmin(actor);
  if (!name.trim()) throw new ValidationError("Name the stage.");
  if (stageId) await prisma.pipelineStage.update({ where: { id: stageId }, data: { name: name.trim().slice(0, 60) } });
  else {
    const last = await prisma.pipelineStage.findFirst({ where: { pipeline: "PROSPECTS", isWon: false }, orderBy: { position: "desc" } });
    const won = await prisma.pipelineStage.findFirst({ where: { pipeline: "PROSPECTS", isWon: true } });
    const position = (last?.position ?? -1) + 1;
    if (won && won.position <= position) await prisma.pipelineStage.update({ where: { id: won.id }, data: { position: position + 1 } });
    await prisma.pipelineStage.create({ data: { pipeline: "PROSPECTS", name: name.trim().slice(0, 60), position } });
  }
  await audit(prisma, { actorId: actor.id, action: "pipeline.stage_saved", entityType: "PipelineStage", entityId: stageId });
}
