import assert from 'node:assert/strict';
import test from 'node:test';

import {
	assertDeploymentAccess,
	planDeploymentAccess,
	type DeploymentAccessSite,
} from './deployment-security.js';

const site: DeploymentAccessSite = {
	id: 'st',
	title: 'stor',
	hostname: 'st.example.workers.dev',
	authorizedEmails: ['owner@example.test'],
};

const app = {
	id: 'access-app',
	name: 'stor',
	domain: site.hostname,
	aud: 'access-audience',
};

test('refuses a real deployment when the Access API token is absent', async () => {
	await assert.rejects(
		assertDeploymentAccess({ token: '' }),
		/CLOUDFLARE_API_TOKEN/,
	);
});

test('blocks a deployment when the target has no exact Access application', () => {
	const issues = planDeploymentAccess([site], [], new Map());

	assert.deepEqual(issues, [
		{
			siteId: 'st',
			hostname: site.hostname,
			kind: 'missing-app',
			detail: `no exact host-wide Access application protects ${site.hostname}`,
		},
	]);
});

test('blocks a deployment when the Access Allow policy misses an authorized email', () => {
	const issues = planDeploymentAccess([site], [app], new Map([[
		app.id,
		[{ id: 'policy', name: 'other', decision: 'allow', include: [] }],
	]]));

	assert.equal(issues.length, 1);
	assert.equal(issues[0].kind, 'missing-policy');
	assert.match(issues[0].detail, /owner@example\.test/);
});

test('allows a deployment only when the exact app and email policy are present', () => {
	const issues = planDeploymentAccess([site], [app], new Map([[
		app.id,
		[{
			id: 'policy',
			name: 'Site access (allow)',
			decision: 'allow',
			include: [{ email: { email: 'owner@example.test' } }],
		}],
	]]));

	assert.deepEqual(issues, []);
});
