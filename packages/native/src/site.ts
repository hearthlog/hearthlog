/**
 * Shared by the apple:* scripts: what makes one site's native app different from another's.
 *
 * Everything per-site comes from the tenant configuration (`tenants.json` or
 * `tenants/<id>/tenant.json`, plus `deployment.json` for a site in its own account:
 * title, accent, hostname, Access team) and the tenant's resign.local.json (your device,
 * team and bundle prefix). Nothing here is deployed or sent anywhere; the apps open the
 * already-deployed site. The Swift sources ship in this package (`swift/`); everything
 * generated goes to the tenant's `.apple-build/`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { brandColor, brandTileSvg } from "@hearthlog/contracts/tenant/brand";
import { themeVariablesFor } from "@hearthlog/contracts/tenant/theme";
import { infrastructureFor, loadTenantConfig, REPOSITORY_ROOT } from "@hearthlog/tooling/tenants/tenant-config.js";

/** The Swift sources of the apps: `Shared`, `macOS`, `iOS`, and `Tests`. */
export const SWIFT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../swift");
/** Everything generated for the tenant: icons, the Mac apps, the iOS project, DerivedData. */
export const BUILD_ROOT = path.join(REPOSITORY_ROOT, ".apple-build");
/** The generated iOS project: `Stor.xcodeproj` and `Generated/` (Info.plist, build settings, icon). */
export const PROJECT_ROOT = path.join(BUILD_ROOT, "project");
export const SETTINGS_FILE = path.join(REPOSITORY_ROOT, "resign.local.json");

const MARK_ON_TILE = "#fbf9fa";

export class AppleError extends Error {}

export interface AppleSettings {
    /** iPhone name as shown in Finder or Xcode, or its UDID (only the iPhone scripts need it). */
    device: string;
    project: string;
    scheme: string;
    /** Site ids to keep installed; at most three fit a free Apple ID. */
    sites: string[];
    renewWithinDays: number;
    /** Apple team id; found from your Apple Development certificate when left out. */
    team: string;
    /** Reverse-DNS prefix; each app is `<prefix>.<site id>`. Must be unique to you for a free team. */
    bundlePrefix: string;
}

export interface AppleSite {
    id: string;
    title: string;
    /** The site's origin (its workers.dev address or hostname), no trailing slash. */
    origin: string;
    host: string;
    /** Cloudflare Access team host; its login opens in the sign-in window. */
    accessHost: string;
    accent: string;
    /** The brand tile colour of the icons. */
    tile: string;
    bundleId: string;
    version: string;
    build: string;
}

export function run(command: string, args: string[], options: { input?: string; quiet?: boolean; cwd?: string } = {}): string {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? REPOSITORY_ROOT,
        encoding: "utf8",
        input: options.input,
        maxBuffer: 64 * 1024 * 1024,
        stdio: options.quiet ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "inherit"],
    });
    if (result.error) throw new AppleError(`${command} could not start: ${result.error.message}`);
    if (result.status !== 0) {
        const detail = options.quiet ? `\n${result.stderr.trim()}` : "";
        throw new AppleError(`${command} ${args[0] ?? ""} exited with ${result.status}${detail}`);
    }
    return result.stdout;
}

export function loadAppleSettings(options: { requireDevice: boolean }): AppleSettings {
    let raw: Partial<AppleSettings> = {};
    if (existsSync(SETTINGS_FILE)) {
        raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Partial<AppleSettings>;
    } else if (options.requireDevice) {
        throw new AppleError(`Missing ${path.relative(REPOSITORY_ROOT, SETTINGS_FILE)}; copy resign.example.json from @hearthlog/native and set your device.`);
    }
    const settings: AppleSettings = {
        device: raw.device ?? "",
        project: raw.project ?? path.relative(REPOSITORY_ROOT, path.join(PROJECT_ROOT, "Stor.xcodeproj")),
        scheme: raw.scheme ?? "Stor iOS",
        sites: raw.sites ?? [],
        renewWithinDays: raw.renewWithinDays ?? 2,
        team: raw.team ?? "",
        bundlePrefix: raw.bundlePrefix ?? "app.stor",
    };
    if (options.requireDevice) {
        if (!settings.device) throw new AppleError("Set \"device\" to the iPhone's name or UDID.");
        if (settings.sites.length === 0) throw new AppleError("List at least one site id in \"sites\".");
        if (settings.sites.length > 3) throw new AppleError("A free Apple ID can keep at most three apps on a device.");
    }
    if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/i.test(settings.bundlePrefix)) {
        throw new AppleError(`bundlePrefix "${settings.bundlePrefix}" must be reverse-DNS, like app.stor`);
    }
    return settings;
}

export async function loadAppleSite(id: string, settings: AppleSettings): Promise<AppleSite> {
    const { infrastructure, sites } = await loadTenantConfig();
    const site = sites.find((candidate) => candidate.id === id);
    if (!site) throw new AppleError(`Unknown site id "${id}" (known: ${sites.map((candidate) => candidate.id).join(", ")})`);
    const origin = site.hostname.replace(/\/+$/, "");
    const accent = site.theme.accent;
    return {
        id: site.id,
        title: site.title,
        origin,
        host: new URL(origin).host,
        // A site in its own account trusts that account's Access team.
        accessHost: new URL(infrastructureFor(site, infrastructure).accessTeamDomain).host,
        accent: accent ?? "",
        tile: brandColor(accent, themeVariablesFor(accent, "light")["--stor-action"]),
        bundleId: `${settings.bundlePrefix}.${site.id}`,
        version: siteVersion(),
        build: buildNumber(),
    };
}

/** The site's package version; a site without one (the development site) takes this package's. */
function siteVersion(): string {
    const read = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version;
    return read(path.join(REPOSITORY_ROOT, "package.json")) ?? read(fileURLToPath(new URL("../package.json", import.meta.url))) ?? "0.0.0";
}

/** Commits on this branch: strictly rising, which is all an installed build number needs. */
function buildNumber(): string {
    try {
        return run("git", ["rev-list", "--count", "HEAD"], { quiet: true }).trim() || "1";
    } catch {
        return "1";
    }
}

// MARK: Info.plist

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function plistXml(value: PlistValue, indent = ""): string {
    const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    if (typeof value === "string") return `${indent}<string>${escape(value)}</string>`;
    if (typeof value === "number") return `${indent}<integer>${value}</integer>`;
    if (typeof value === "boolean") return `${indent}<${value}/>`;
    if (Array.isArray(value)) {
        if (value.length === 0) return `${indent}<array/>`;
        return `${indent}<array>\n${value.map((item) => plistXml(item, `${indent}    `)).join("\n")}\n${indent}</array>`;
    }
    const entries = Object.entries(value);
    if (entries.length === 0) return `${indent}<dict/>`;
    return `${indent}<dict>\n${entries
        .map(([key, item]) => `${indent}    <key>${escape(key)}</key>\n${plistXml(item, `${indent}    `)}`)
        .join("\n")}\n${indent}</dict>`;
}

export function plistDocument(entries: { [key: string]: PlistValue }): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistXml(entries)}
</plist>
`;
}

function storSite(site: AppleSite): PlistValue {
    return { id: site.id, title: site.title, origin: site.origin, accessHost: site.accessHost };
}

const CAMERA_USAGE = (site: AppleSite) => `${site.title} uses the camera to scan food barcodes.`;

export function macInfoPlist(site: AppleSite, options: { executable: string; development: boolean; inspectable: boolean }): string {
    return plistDocument({
        CFBundleDevelopmentRegion: "en",
        CFBundleExecutable: options.executable,
        CFBundleIconFile: "AppIcon",
        CFBundleIdentifier: site.bundleId,
        CFBundleInfoDictionaryVersion: "6.0",
        CFBundleName: site.title,
        CFBundleDisplayName: site.title,
        CFBundlePackageType: "APPL",
        CFBundleShortVersionString: site.version,
        CFBundleVersion: site.build,
        LSApplicationCategoryType: "public.app-category.productivity",
        LSMinimumSystemVersion: "14.0",
        NSCameraUsageDescription: CAMERA_USAGE(site),
        NSHighResolutionCapable: true,
        NSPrincipalClass: "NSApplication",
        StorSite: storSite(site),
        StorInspectable: options.inspectable,
        ...(options.development ? { StorDevelopmentOverrides: true } : {}),
    });
}

/** Build settings come from Site.xcconfig; this file carries what is not a single setting. */
export function iosInfoPlist(site: AppleSite): string {
    return plistDocument({
        CFBundleDevelopmentRegion: "en",
        CFBundleDisplayName: site.title,
        CFBundleExecutable: "$(EXECUTABLE_NAME)",
        CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
        CFBundleInfoDictionaryVersion: "6.0",
        CFBundleName: "$(PRODUCT_NAME)",
        CFBundlePackageType: "$(PRODUCT_BUNDLE_PACKAGE_TYPE)",
        CFBundleShortVersionString: "$(MARKETING_VERSION)",
        CFBundleVersion: "$(CURRENT_PROJECT_VERSION)",
        ITSAppUsesNonExemptEncryption: false,
        LSRequiresIPhoneOS: true,
        NSCameraUsageDescription: CAMERA_USAGE(site),
        StorSite: storSite(site),
        UIApplicationSceneManifest: {
            UIApplicationSupportsMultipleScenes: false,
            UISceneConfigurations: {
                UIWindowSceneSessionRoleApplication: [
                    { UISceneConfigurationName: "Default Configuration", UISceneDelegateClassName: "StorSceneDelegate" },
                ],
            },
        },
        UILaunchScreen: {},
        UIRequiredDeviceCapabilities: ["arm64"],
        UISupportedInterfaceOrientations: ["UIInterfaceOrientationPortrait"],
        "UISupportedInterfaceOrientations~ipad": [
            "UIInterfaceOrientationPortrait",
            "UIInterfaceOrientationPortraitUpsideDown",
            "UIInterfaceOrientationLandscapeLeft",
            "UIInterfaceOrientationLandscapeRight",
        ],
        // Service workers and script messages in WKWebView need the site's host listed here.
        WKAppBoundDomains: [site.host],
    });
}

// MARK: Icons

export interface RenderedIcons {
    /** Full-bleed tile, no transparency, as iOS wants. */
    ios: string;
    /** Rounded tile on the macOS icon grid, with its shadow. */
    mac: string;
}

/** Renders the brand tile at 1024px for both platforms, using the Chromium Playwright already installs. */
export async function renderIcons(site: AppleSite, directory: string): Promise<RenderedIcons> {
    mkdirSync(directory, { recursive: true });
    let chromium: typeof import("@playwright/test").chromium;
    try {
        ({ chromium } = await import("@playwright/test"));
    } catch {
        throw new AppleError("Rendering the icons needs Playwright: add @playwright/test to the devDependencies.");
    }
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
        const ios = path.join(directory, "icon-ios-1024.png");
        const mac = path.join(directory, "icon-mac-1024.png");

        const flat = brandTileSvg({ background: site.tile, fill: MARK_ON_TILE, scale: 0.62 }).replace("<svg ", '<svg width="1024" height="1024" ');
        await page.setContent(`<body style="margin:0">${flat}</body>`);
        writeFileSync(ios, await page.screenshot({ type: "png" }));

        // macOS draws no mask of its own: the tile is 824px on a 1024px grid, with a soft shadow below it.
        const tile = brandTileSvg({ background: site.tile, fill: MARK_ON_TILE, scale: 0.66, radius: 114 }).replace("<svg ", '<svg width="824" height="824" ');
        await page.setContent(`<body style="margin:0;width:1024px;height:1024px;display:grid;place-items:center"><div style="filter:drop-shadow(0 10px 14px rgba(0,0,0,.28));line-height:0;margin-top:-6px">${tile}</div></body>`);
        writeFileSync(mac, await page.screenshot({ type: "png", omitBackground: true }));
        return { ios, mac };
    } finally {
        await browser.close();
    }
}
