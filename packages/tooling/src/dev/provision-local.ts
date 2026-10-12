import {
    ensureLocalLedgerCredential,
    localLedgerCredentialPath,
} from "./local-development.js";

const result = await ensureLocalLedgerCredential({
    adminToken: process.env.ADMIN_TOKEN ?? "",
});

console.log(
    `${result.reused ? "Reused" : "Provisioned"} local Ledger gateway ` +
        `credential at ${localLedgerCredentialPath()} (token not printed)`,
);
