import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGalleryPublicConfig } from './gallery-public-config.js';
import { loadTenantConfig } from '../tenants/tenant-config.js';

test('public Worker config contains only public bucket and canonical origins', async () => {
    const { infrastructure } = await loadTenantConfig();
    const config = buildGalleryPublicConfig(infrastructure);
    assert.equal(config.main, './dist/worker/index.js');
    assert.equal(config.preview_urls, false);
    assert.equal('build' in config, false);
    assert.deepEqual(config.compatibility_flags, ['nodejs_als']);
    assert.deepEqual(config.r2_buckets, [{ binding: 'GALLERY_PUBLIC', bucket_name: infrastructure.galleryPublicBucket }]);
    assert.equal(config.vars.PUBLIC_ORIGIN, infrastructure.galleryPublicOrigin);
    assert.equal('services' in config, false);
    assert.equal('assets' in config, false);
});
