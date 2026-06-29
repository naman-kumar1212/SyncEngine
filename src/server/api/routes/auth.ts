import { Router } from 'express';
import { validate } from '../middleware/validate.middleware';
import { LoginSchema, RegisterSchema } from '../../security/input-sanitizer';
import { authenticateUser, registerUser, rotateRefreshToken } from '../../security/jwt';

const router = Router();

/** POST /api/auth/register */
router.post('/register', validate(RegisterSchema), async (req, res) => {
  const result = await registerUser(req.body);
  if ('error' in result) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.status(201).json({ userId: result.userId });
});

/** POST /api/auth/login */
router.post('/login', validate(LoginSchema), async (req, res) => {
  const tokens = await authenticateUser(req.body.email, req.body.password);
  if (!tokens) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  res
    .cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    })
    .json({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn });
});

/** POST /api/auth/refresh */
router.post('/refresh', async (req, res) => {
  const rawToken = req.cookies?.refreshToken;
  if (!rawToken) {
    res.status(401).json({ error: 'No refresh token' });
    return;
  }
  const result = await rotateRefreshToken(rawToken);
  if (!result) {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
    return;
  }
  res
    .cookie('refreshToken', result.tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
    .json({ accessToken: result.tokens.accessToken, expiresIn: result.tokens.expiresIn });
});

/** POST /api/auth/logout */
router.post('/logout', (req, res) => {
  res.clearCookie('refreshToken').json({ ok: true });
});

export default router;
