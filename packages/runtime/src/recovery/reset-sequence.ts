export interface ResetDependencies {
    stopSynchronization: () => Promise<void>;
    deleteDatabase: () => Promise<void>;
    markReset: () => void;
    hardReload: () => void;
}

export async function executeLocalReset(dependencies: ResetDependencies): Promise<void> {
    await dependencies.stopSynchronization();
    dependencies.markReset();
    await dependencies.deleteDatabase();
    dependencies.hardReload();
}
