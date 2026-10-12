import { AppRegistry } from "../src/app-registry";
import { LedgerApp } from "../src/ledger-app";

export { AppRegistry, LedgerApp };

export default {
    fetch(): Response {
        return new Response(null, { status: 404 });
    },
} satisfies ExportedHandler<Env>;
