#!/usr/bin/env npx tsx
/**
 * Brand Icon Generator
 *
 * Renders the brand mark into one icon set per tenant under
 * tenants/<site-id>/static/icons/<site-id>/ (favicon, Apple touch icon, PWA and maskable icons),
 * plus the default packages/shell/static/favicon.ico. The tile colour comes from the tenant
 * accent; tenants without one use the original teal. Rasterizing uses the
 * Chromium that Playwright already installs.
 *
 * The output is committed. Re-run after changing the mark or a tenant accent:
 *
 *   pnpm generate:icons
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { chromium } from "@playwright/test";

import {
    brandColor,
    brandTileSvg,
    BRAND_MARK_DEFAULT_COLOR,
} from "@hearthlog/contracts/tenant/brand";
import { themeVariablesFor } from "@hearthlog/contracts/tenant/theme";
import {
    loadTenantConfig,
    REPOSITORY_ROOT,
    validateCrossSite,
} from "../tenants/tenant-config.js";

const MARK_ON_TILE = "#fbf9fa";

interface IconSpec {
    file: string;
    size: number;
    scale: number;
    /** Rounded tile with transparent corners instead of full bleed. */
    radius?: number;
}

const ICONS: readonly IconSpec[] = [
    // Full bleed: iOS applies its own mask and rejects transparency.
    { file: "apple-touch-icon.png", size: 180, scale: 0.62 },
    { file: "pwa-192.png", size: 192, scale: 0.66, radius: 112 },
    { file: "pwa-512.png", size: 512, scale: 0.66, radius: 112 },
    // Maskable icons keep the mark inside the 80% safe circle.
    { file: "maskable-512.png", size: 512, scale: 0.5 },
];

const FAVICON_SIZES = [16, 32, 48] as const;

/** Packs PNGs into one ICO container (PNG-compressed entries). */
function icoFromPngs(entries: readonly { size: number; png: Buffer }[]): Buffer {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(entries.length, 4);
    let offset = 6 + entries.length * 16;
    const directory = entries.map(({ size, png }) => {
        const entry = Buffer.alloc(16);
        entry.writeUInt8(size, 0);
        entry.writeUInt8(size, 1);
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(png.length, 8);
        entry.writeUInt32LE(offset, 12);
        offset += png.length;
        return entry;
    });
    return Buffer.concat([header, ...directory, ...entries.map(({ png }) => png)]);
}

const { sites } = await loadTenantConfig();
validateCrossSite(sites);

const browser = await chromium.launch();
const page = await browser.newPage();

async function render(svg: string, size: number): Promise<Buffer> {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
        `<body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">` +
            svg.replace("<svg ", `<svg width="${size}" height="${size}" `) +
            `</div></body>`,
    );
    return page.screenshot({ omitBackground: true, type: "png" });
}

async function faviconIco(svg: string): Promise<Buffer> {
    return icoFromPngs(
        await Promise.all(
            FAVICON_SIZES.map(async (size) => ({
                size,
                png: await render(svg, size),
            })),
        ),
    );
}

function faviconSvg(background: string): string {
    return brandTileSvg({ background, fill: MARK_ON_TILE, scale: 0.7, radius: 112 });
}

try {
    for (const site of sites) {
        const accent = site.theme.accent;
        const action = themeVariablesFor(accent, "light")["--stor-action"];
        const background = brandColor(accent, action);
        const directory = join(REPOSITORY_ROOT, "tenants", site.id, "static", "icons", site.id);
        await mkdir(directory, { recursive: true });

        for (const { file, size, scale, radius } of ICONS) {
            const svg = brandTileSvg({ background, fill: MARK_ON_TILE, scale, radius });
            await writeFile(join(directory, file), await render(svg, size));
        }
        await writeFile(join(directory, "favicon.ico"), await faviconIco(faviconSvg(background)));
        console.log(`Generated icons for "${site.id}" (${background}).`);
    }

    // Default for clients that request /favicon.ico without reading the page; the shell ships it to every site.
    await writeFile(
        join(REPOSITORY_ROOT, "packages", "shell", "static", "favicon.ico"),
        await faviconIco(faviconSvg(BRAND_MARK_DEFAULT_COLOR)),
    );
} finally {
    await browser.close();
}
