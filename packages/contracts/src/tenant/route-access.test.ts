import { describe, expect, it } from "vitest";

import { createTenantConfig, type TenantModule } from "./config";
import { moduleRedirect, tenantRouteRedirect } from "./route-access";

// Module features: the generated feature union holds only the ones the workspace installs.
const features = (...ids: string[]) => ids as unknown as TenantModule["features"];

const restrictedTenantModule: TenantModule = {
    id: "bravo",
    ledgerAppName: "bravo",
    title: "bravo",
    home: "/",
    features: features("calendar", "calories", "bmi"),
    developerNavVisible: false,
    entitiesNavVisible: true,
    dynamicEntities: false,
    theme: {},
    admin: false,
    hostname: "https://bravo.example.test",
    kalApiOrigin: "",
};

const restrictedTenant = createTenantConfig(restrictedTenantModule);

const entitiesHiddenTenant = createTenantConfig({
    ...restrictedTenantModule,
    entitiesNavVisible: false,
});

describe("tenant route access", () => {
    it("redirects direct URLs for disabled feature pages", () => {
        expect(tenantRouteRedirect("/finance", restrictedTenant)).toBe("/");
        expect(tenantRouteRedirect("/finance/2026/8", restrictedTenant)).toBe("/");
        expect(tenantRouteRedirect("/gallery", restrictedTenant)).toBe("/");
        expect(tenantRouteRedirect("/invoices", restrictedTenant)).toBe("/");
    });

    it("always opens Calendar, even for a tenant that does not list it", () => {
        const tenant = createTenantConfig({ ...restrictedTenantModule, features: features("calories") });
        expect(tenant.features.has("calendar")).toBe(true);
        expect(tenantRouteRedirect("/calendar", tenant)).toBeNull();
        expect(tenant.approvedEntities.entityNames.has("calendar_event")).toBe(true);
    });

    it("opens the Health day view only with at least two Health features", () => {
        expect(tenantRouteRedirect("/health", restrictedTenant)).toBeNull();
        const bodyOnly = createTenantConfig({ ...restrictedTenantModule, features: features("calendar", "bmi") });
        expect(tenantRouteRedirect("/health", bodyOnly)).toBe("/");
    });

    it("redirects hidden operational and unapproved entity routes", () => {
        expect(tenantRouteRedirect("/developer", restrictedTenant)).toBe("/");
        expect(tenantRouteRedirect("/entities/transaction", restrictedTenant)).toBe("/");
        expect(tenantRouteRedirect("/entities/asset", restrictedTenant)).toBe("/");
        expect(tenantRouteRedirect("/entities/custom_record", restrictedTenant)).toBe("/");
    });

    it("allows only the tenant contract", () => {
        expect(tenantRouteRedirect("/", restrictedTenant)).toBeNull();
        expect(tenantRouteRedirect("/calendar/2026-08-30", restrictedTenant)).toBeNull();
        expect(tenantRouteRedirect("/calories/foods", restrictedTenant)).toBeNull();
        expect(tenantRouteRedirect("/entities/calendar_event", restrictedTenant)).toBeNull();
        expect(tenantRouteRedirect("/entities", restrictedTenant)).toBeNull();
        expect(tenantRouteRedirect("/unknown", restrictedTenant)).toBeNull();
    });

    it("can disable the entire entities viewer", () => {
        expect(tenantRouteRedirect("/entities", entitiesHiddenTenant)).toBe("/");
        expect(tenantRouteRedirect("/entities/calendar_event", entitiesHiddenTenant)).toBe("/");
    });

    it("moves a module's old address only when its new page's feature is on", () => {
        const features = new Set(["bmi", "activities"]);
        expect(moduleRedirect(new URL("https://x.test/bmi?section=activity&date=2026-10-01"), features))
            .toBe("/activities?date=2026-10-01");
        expect(moduleRedirect(new URL("https://x.test/bmi?section=activity"), new Set(["bmi"]))).toBeNull();
        expect(moduleRedirect(new URL("https://x.test/bmi"), features)).toBeNull();
    });
});
