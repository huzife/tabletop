import { asc, eq, inArray } from "drizzle-orm";

import type { TabletopDatabase } from "../connection.js";
import {
  gameServiceSettings,
  siteSettings,
  type GameServiceSettings,
  type SiteSettings,
} from "../schema.js";

import type { RepositoryDependencies } from "./types.js";

export const DEFAULT_MAINTENANCE_MESSAGE = "网站维护中，请稍后再试。";

export interface UpdateSiteSettingsInput {
  readonly enabled: boolean;
  readonly updatedBy: string | null;
  readonly maintenanceMessage?: string;
  readonly now?: number;
}

export interface UpdateGameServiceInput {
  readonly enabled: boolean;
  readonly updatedBy: string | null;
  readonly now?: number;
}

export class ServiceSettingsRepository {
  constructor(
    private readonly database: TabletopDatabase,
    private readonly dependencies: RepositoryDependencies,
  ) {}

  initializeSite(now = this.dependencies.clock()): SiteSettings {
    this.database
      .insert(siteSettings)
      .values({
        singletonId: 1,
        enabled: true,
        maintenanceMessage: DEFAULT_MAINTENANCE_MESSAGE,
        updatedAt: now,
        updatedBy: null,
      })
      .onConflictDoNothing()
      .run();

    const settings = this.getSite();
    if (settings === undefined) {
      throw new Error("初始化全站服务开关失败");
    }
    return settings;
  }

  getSite(): SiteSettings | undefined {
    return this.database.select().from(siteSettings).where(eq(siteSettings.singletonId, 1)).get();
  }

  updateSite(input: UpdateSiteSettingsInput): SiteSettings | undefined {
    const maintenanceMessage = input.maintenanceMessage?.trim();
    const update = {
      enabled: input.enabled,
      updatedAt: input.now ?? this.dependencies.clock(),
      updatedBy: input.updatedBy,
      ...(maintenanceMessage === undefined ? {} : { maintenanceMessage }),
    };

    return this.database
      .update(siteSettings)
      .set(update)
      .where(eq(siteSettings.singletonId, 1))
      .returning()
      .get();
  }

  syncRegisteredGames(gameIds: readonly string[], now = this.dependencies.clock()): number {
    const uniqueGameIds = [...new Set(gameIds)].sort();
    if (uniqueGameIds.length === 0) {
      return 0;
    }

    return this.database
      .insert(gameServiceSettings)
      .values(
        uniqueGameIds.map((gameId) => ({
          gameId,
          enabled: true,
          updatedAt: now,
          updatedBy: null,
        })),
      )
      .onConflictDoNothing()
      .run().changes;
  }

  findGame(gameId: string): GameServiceSettings | undefined {
    return this.database
      .select()
      .from(gameServiceSettings)
      .where(eq(gameServiceSettings.gameId, gameId))
      .get();
  }

  listGames(): GameServiceSettings[] {
    return this.database
      .select()
      .from(gameServiceSettings)
      .orderBy(asc(gameServiceSettings.gameId))
      .all();
  }

  listRegisteredGames(gameIds: readonly string[]): GameServiceSettings[] {
    const uniqueGameIds = [...new Set(gameIds)];
    if (uniqueGameIds.length === 0) {
      return [];
    }

    return this.database
      .select()
      .from(gameServiceSettings)
      .where(inArray(gameServiceSettings.gameId, uniqueGameIds))
      .orderBy(asc(gameServiceSettings.gameId))
      .all();
  }

  updateGame(gameId: string, input: UpdateGameServiceInput): GameServiceSettings | undefined {
    return this.database
      .update(gameServiceSettings)
      .set({
        enabled: input.enabled,
        updatedAt: input.now ?? this.dependencies.clock(),
        updatedBy: input.updatedBy,
      })
      .where(eq(gameServiceSettings.gameId, gameId))
      .returning()
      .get();
  }
}
