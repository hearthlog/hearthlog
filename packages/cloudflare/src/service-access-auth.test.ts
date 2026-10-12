import { describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { verifyServiceJwt, verifyStorJwt } from './access-auth';

const CLIENT = 'abcdef0123456789abcdef0123456789.access';

describe('service token verification', () => {
    async function signer() {
        const { publicKey, privateKey } = await generateKeyPair('RS256');
        const sign = (claims: Record<string, unknown>, audience: string) =>
            new SignJWT({ type: 'app', ...claims })
                .setProtectedHeader({ alg: 'RS256' })
                .setIssuer('https://team.example')
                .setAudience(audience)
                .setExpirationTime('5m')
                .sign(privateKey);
        return { publicKey, sign };
    }
    const config = { audience: 'integrations-aud', issuer: 'https://team.example' };

    it('reads the client id from a token for the integrations application', async () => {
        const { publicKey, sign } = await signer();
        expect(await verifyServiceJwt(await sign({ common_name: CLIENT }, 'integrations-aud'), config, publicKey)).toEqual({ clientId: CLIENT });
    });

    it('rejects other audiences and tokens without a client id', async () => {
        const { publicKey, sign } = await signer();
        await expect(verifyServiceJwt(await sign({ common_name: CLIENT }, 'main-aud'), config, publicKey)).rejects.toThrow();
        await expect(verifyServiceJwt(await sign({ email: 'a@example.com' }, 'integrations-aud'), config, publicKey)).rejects.toThrow();
    });

    it('is never accepted by the main application, which needs an allow-listed email', async () => {
        const { publicKey, sign } = await signer();
        const token = await sign({ common_name: CLIENT }, 'main-aud');
        await expect(verifyStorJwt(token, { audience: 'main-aud', issuer: 'https://team.example', allowedEmails: ['a@example.com'] }, publicKey)).rejects.toBeInstanceOf(Error);
    });
});
