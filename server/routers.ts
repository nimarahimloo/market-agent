import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { appendAuditEventToDb, createAgentRun, createAgentRunEvent, getAgentOutputsByOwner, getAgentRunEventsByOwner, getAgentRunsByOwner, getAuditEventsByOwner, getHistoricalDataRunsByOwner, getHistoricalDatasetsByOwner, getIntegrationsByOwner, getIntelligenceByOwner, getInstrumentsByOwner, getOpportunityHistoryByOwner, getOpportunityRecordsByOwner, getRecentWatchdogEventsByOwner, getPaperAlertsByOwner, getRiskControlsByOwner, getSignalsByOwner, getSimulationsByOwner, getWalletConnectionByOwner, getWalletConnectionByTaskUid, markWalletHeartbeat, markWalletReadAt, recordAgentOutput, recordHistoricalDataRun, recordHistoricalDataset, recordPaperAlert, updateAgentRun, updateOpportunityRecord, updateWalletMonitor, upsertOpportunityRecord, upsertWalletConnection, upsertUser, getUserByOpenId } from "./db";
import { fetchMassiveHistorical } from "./massiveData";
import { runAgentArmy, runAgentArmyBatch } from "./agentOrchestrator";
import { parseFlatFileChunks, type FlatFileMapping } from "../shared/flatFile";
import { createHash } from "node:crypto";
import { storagePut } from "./storage";
import { ENV } from "./_core/env";
import { fetchEarlyWarnings, type EarlyWarningItem } from "./intelligence";
import { listLLMModels } from "./_core/llm";
import { buildAgentBatchCancelledAudit, buildCancelledRunPatch } from "../shared/agentRun";
import { buildMacroContext } from "./macroContext";
import { calculatePostReleaseReaction, calibrateSurpriseSeverity } from "../shared/marketReaction";
import { fetchReadOnlyWalletPortfolio, validatePublicWalletAddress, walletNetworkSchema } from "./wallet";
import { getSessionTokenFromRequest } from "./sessionToken";
import { deriveWalletMonitorState, shouldChangeWalletMonitor } from "../shared/walletMonitor";
import { createHeartbeatJob, updateHeartbeatJob } from "./_core/heartbeat";
import { sdk } from "./_core/sdk";
import { TRPCError } from "@trpc/server";

// Simple local credentials — override with env vars if needed
const LOCAL_USERNAME = process.env.LOCAL_AUTH_USERNAME ?? "admin";
const LOCAL_PASSWORD = process.env.LOCAL_AUTH_PASSWORD ?? "admin123";
const LOCAL_OPEN_ID = process.env.LOCAL_AUTH_OPEN_ID ?? "local-admin";

const radarEventInput = z.object({ provider: z.enum(["gdelt", "google-news", "bbc-news", "stale-cache"]).default("gdelt"), id: z.string().max(160), title: z.string().min(1).max(500), url: z.string().url(), publishedAt: z.string(), retrievedAt: z.string(), source: z.string(), sourceTier: z.enum(["discovery", "financial-media", "official"]), severity: z.enum(["low", "medium", "high"]), markets: z.array(z.string()).max(12), entities: z.array(z.string()).max(24).optional(), summary: z.string().max(2000).optional() });
const agentRunOptionsInput = z.object({ agentBudget: z.number().int().min(1).max(20).optional(), retryCount: z.number().int().min(0).max(3).optional(), model: z.string().max(120).optional() }).optional();

const activeBatchCancels = new Map<number, { cancelled: boolean }>();

async function persistArmyResults(ownerId: number, runId: number | null | undefined, entries: Array<{ event: z.infer<typeof radarEventInput>; result: Awaited<ReturnType<typeof runAgentArmy>> }>) {
  if (!runId) return;
  for (const entry of entries) {
    const runEventId = await createAgentRunEvent({ ownerId, runId, eventId: entry.result.eventId, eventTitle: entry.event.title, eventUrl: entry.event.url, severity: entry.event.severity, status: entry.result.consensus.canPaperTest ? "completed" : "partial", consensus: entry.result.consensus as unknown as Record<string, unknown>, analyses: entry.result.analyses as unknown as unknown[] });
    if (runEventId) {
      await appendAuditEventToDb({ ownerId, eventType: "agent_army_consensus", entityType: "early_warning", entityId: runEventId, payload: { eventId: entry.result.eventId, runId: entry.result.runId, model: entry.result.model, consensus: entry.result.consensus } });
    }
  }
}

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
    /** Simple username/password login — no Manus OAuth required */
    login: publicProcedure
      .input(z.object({
        username: z.string().min(1).max(64),
        password: z.string().min(1).max(128),
      }))
      .mutation(async ({ ctx, input }) => {
        if (input.username !== LOCAL_USERNAME || input.password !== LOCAL_PASSWORD) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid username or password" });
        }

        try {
          await upsertUser({
            openId: LOCAL_OPEN_ID,
            name: "Admin",
            email: "admin@local",
            loginMethod: "local",
            role: "admin",
            lastSignedIn: new Date(),
          });
        } catch (err) {
          console.warn("[Auth] upsertUser on login failed (DB may be offline):", err);
        }

        let sessionToken: string;
        try {
          sessionToken = await sdk.createSessionToken(LOCAL_OPEN_ID, {
            name: "Admin",
            expiresInMs: ONE_YEAR_MS,
          });
        } catch (err) {
          console.error("[Auth] createSessionToken failed:", err);
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Could not create session. Check JWT_SECRET is set.",
          });
        }

        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

        const user = await getUserByOpenId(LOCAL_OPEN_ID);
        const now = new Date();
        return {
          success: true as const,
          user: user ?? {
            id: 1,
            openId: LOCAL_OPEN_ID,
            name: "Admin",
            email: "admin@local",
            loginMethod: "local",
            role: "admin" as const,
            createdAt: now,
            updatedAt: now,
            lastSignedIn: now,
          },
        };
      }),
  }),

  market: router({
    watchlist: protectedProcedure.query(({ ctx }) => getInstrumentsByOwner(ctx.user.id)),
    audit: protectedProcedure.query(({ ctx }) => getAuditEventsByOwner(ctx.user.id)),
    watchdog: protectedProcedure.query(({ ctx }) => getRecentWatchdogEventsByOwner(ctx.user.id)),
    signals: protectedProcedure.query(({ ctx }) => getSignalsByOwner(ctx.user.id)),
    intelligence: protectedProcedure.query(({ ctx }) => getIntelligenceByOwner(ctx.user.id)),
    earlyWarnings: protectedProcedure.input(z.object({ query: z.string().min(3).max(240).optional() }).optional()).query(({ input }) => fetchEarlyWarnings(input?.query)),
    agentRuns: protectedProcedure.query(({ ctx }) => getAgentRunsByOwner(ctx.user.id)),
    agentRunEvents: protectedProcedure.input(z.object({ runId: z.number().int().positive().optional() }).optional()).query(({ ctx, input }) => getAgentRunEventsByOwner(ctx.user.id, input?.runId)),
    agentModels: protectedProcedure.query(async () => (await listLLMModels()).data.map(model => ({ id: model.id, owner: model.owned_by }))),
    macroContext: protectedProcedure.query(() => buildMacroContext()),
    analyzeEvent: protectedProcedure.input(z.object({ event: radarEventInput, options: agentRunOptionsInput })).mutation(async ({ ctx, input }) => { const startedAt = new Date(); const runId = await createAgentRun({ ownerId: ctx.user.id, mode: "single", status: "running", requestedCount: 1, maxCalls: (input.options?.agentBudget ?? 6) * (1 + (input.options?.retryCount ?? 1)), budgetUnits: input.options?.agentBudget ?? 6, startedAt }); try { const result = await runAgentArmy(input.event, input.options); await persistArmyResults(ctx.user.id, runId, [{ event: input.event, result }]); await updateAgentRun(ctx.user.id, runId ?? 0, { status: result.consensus.canPaperTest ? "completed" : "partial", completedCount: result.analyses.filter(agent => agent.status === "completed").length, failedCount: result.analyses.filter(agent => agent.status === "failed").length, finishedAt: new Date() }); return result; } catch (error) { if (runId) await updateAgentRun(ctx.user.id, runId, { status: "failed", failedCount: 1, finishedAt: new Date() }); throw error; } }),
    analyzeBatch: protectedProcedure.input(z.object({ events: z.array(radarEventInput).min(1).max(12), options: agentRunOptionsInput })).mutation(async ({ ctx, input }) => { const startedAt = new Date(); const runId = await createAgentRun({ ownerId: ctx.user.id, mode: "batch", status: "running", requestedCount: input.events.length, maxCalls: input.events.length * (input.options?.agentBudget ?? 6) * (1 + (input.options?.retryCount ?? 1)), budgetUnits: (input.options?.agentBudget ?? 6) * input.events.length, startedAt }); const cancelToken = { cancelled: false }; if (runId) activeBatchCancels.set(runId, cancelToken); try { const results = await runAgentArmyBatch(input.events, input.options, cancelToken); await persistArmyResults(ctx.user.id, runId, results.map((result, index) => ({ event: input.events[index]!, result }))); await updateAgentRun(ctx.user.id, runId ?? 0, { status: cancelToken.cancelled ? "cancelled" : "completed", completedCount: results.filter(r => r.consensus.canPaperTest).length, failedCount: results.filter(r => !r.consensus.canPaperTest).length, finishedAt: new Date() }); return results; } catch (error) { if (runId) await updateAgentRun(ctx.user.id, runId, { status: "failed", failedCount: input.events.length, finishedAt: new Date() }); throw error; } finally { if (runId) activeBatchCancels.delete(runId); } }),
    cancelBatch: protectedProcedure.input(z.object({ runId: z.number().int().positive() })).mutation(async ({ ctx, input }) => { const token = activeBatchCancels.get(input.runId); if (token) token.cancelled = true; await updateAgentRun(ctx.user.id, input.runId, buildCancelledRunPatch()); await appendAuditEventToDb(buildAgentBatchCancelledAudit(ctx.user.id, input.runId)); return { runId: input.runId, cancelled: true }; }),
    paperAlerts: protectedProcedure.query(({ ctx }) => getPaperAlertsByOwner(ctx.user.id)),
    recordPaperAlert: protectedProcedure.input(z.object({ warningId: z.string().max(160), headline: z.string().min(1).max(500), severity: z.enum(["low", "medium", "high"]), confidence: z.number().int().min(0).max(100), reason: z.string().min(1).max(500) })).mutation(({ ctx, input }) => recordPaperAlert({ ...input, ownerId: ctx.user.id })),
    opportunities: protectedProcedure.query(({ ctx }) => getOpportunityRecordsByOwner(ctx.user.id)),
    saveOpportunity: protectedProcedure.input(z.object({ externalKey: z.string().max(64), title: z.string().min(1).max(180), url: z.string().url(), source: z.string().min(1).max(180), verification: z.string().min(1).max(1000), status: z.enum(["new", "reviewing", "verified", "dismissed"]).optional(), note: z.string().max(2000).nullable().optional() })).mutation(({ ctx, input }) => upsertOpportunityRecord({ ...input, ownerId: ctx.user.id })),
    updateOpportunity: protectedProcedure.input(z.object({ id: z.number().int().positive(), status: z.enum(["new", "reviewing", "verified", "dismissed"]).optional(), note: z.string().max(2000).nullable().optional() })).mutation(({ ctx, input }) => updateOpportunityRecord({ ...input, ownerId: ctx.user.id })),
    opportunityHistory: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(({ ctx, input }) => getOpportunityHistoryByOwner(ctx.user.id, input.id)),
    agents: protectedProcedure.query(({ ctx }) => getAgentOutputsByOwner(ctx.user.id)),
    risk: protectedProcedure.query(({ ctx }) => getRiskControlsByOwner(ctx.user.id)),
    simulations: protectedProcedure.query(({ ctx }) => getSimulationsByOwner(ctx.user.id)),
    integrations: protectedProcedure.query(({ ctx }) => getIntegrationsByOwner(ctx.user.id)),
    walletConnection: protectedProcedure.query(async ({ ctx }) => {
      const connection = await getWalletConnectionByOwner(ctx.user.id);
      if (!connection) return null;
      return { ...connection, monitorStatus: deriveWalletMonitorState({ enabled: connection.monitorEnabled, status: connection.monitorStatus, lastHeartbeatAt: connection.lastHeartbeatAt }) };
    }),
    connectWallet: protectedProcedure.input(z.object({ address: z.string().min(8).max(128), network: walletNetworkSchema })).mutation(async ({ ctx, input }) => {
      const address = validatePublicWalletAddress(input.address, input.network);
      return upsertWalletConnection({ ownerId: ctx.user.id, address, network: input.network });
    }),
    walletPortfolio: protectedProcedure.query(async ({ ctx }) => {
      const connection = await getWalletConnectionByOwner(ctx.user.id);
      if (!connection) return null;
      return fetchReadOnlyWalletPortfolio(connection.address, connection.network);
    }),
    walletHeartbeat: protectedProcedure.mutation(async ({ ctx }) => {
      const connection = await getWalletConnectionByOwner(ctx.user.id);
      if (!connection) throw new TRPCError({ code: "NOT_FOUND", message: "No wallet connected" });
      await markWalletHeartbeat(ctx.user.id);
      return { ok: true as const };
    }),
    setWalletMonitor: protectedProcedure.input(z.object({ enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
      const connection = await getWalletConnectionByOwner(ctx.user.id);
      if (!connection) throw new TRPCError({ code: "NOT_FOUND", message: "No wallet connected" });
      if (!shouldChangeWalletMonitor(connection.monitorEnabled, input.enabled)) return connection;
      return updateWalletMonitor({ ownerId: ctx.user.id, enabled: input.enabled });
    }),
    historicalDatasets: protectedProcedure.query(({ ctx }) => getHistoricalDatasetsByOwner(ctx.user.id)),
    historicalDataRuns: protectedProcedure.query(({ ctx }) => getHistoricalDataRunsByOwner(ctx.user.id)),
    fetchHistorical: protectedProcedure.input(z.object({ symbol: z.string().min(1).max(32), from: z.string(), to: z.string() })).mutation(async ({ ctx, input }) => {
      const data = await fetchMassiveHistorical(input.symbol, input.from, input.to);
      const runId = await recordHistoricalDataRun({ ownerId: ctx.user.id, symbol: input.symbol, from: input.from, to: input.to, status: "completed" });
      return { runId, data };
    }),
    recordAgentOutput: protectedProcedure.input(z.object({ runId: z.number().int().positive().optional(), title: z.string().min(1).max(240), content: z.string().min(1).max(20000), model: z.string().max(120).optional() })).mutation(({ ctx, input }) => recordAgentOutput({ ...input, ownerId: ctx.user.id })),
    appendAudit: protectedProcedure.input(z.object({
      eventType: z.string().min(1).max(120),
      entityType: z.string().min(1).max(120).optional(),
      entityId: z.union([z.string(), z.number()]).optional(),
      payload: z.unknown().optional(),
    })).mutation(({ ctx, input }) => appendAuditEventToDb({ ...input, ownerId: ctx.user.id })),
  }),
});

export type AppRouter = typeof appRouter;
