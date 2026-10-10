import { ExecutionContext } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ProfilePictureAuthGuard } from './profile-picture-auth.guard';

const mockPassportCanActivate = jest.fn<boolean, [ExecutionContext]>();

jest.mock('@nestjs/passport', () => ({
  AuthGuard: jest.fn(
    () =>
      class {
        canActivate(context: ExecutionContext) {
          return mockPassportCanActivate(context);
        }
      },
  ),
}));

function mockContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('JWT authentication guards', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalMockFlag = process.env.MOCK_PROFILE_UPLOAD;

  beforeEach(() => {
    mockPassportCanActivate.mockReset();
    mockPassportCanActivate.mockReturnValue(false);
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    if (originalMockFlag === undefined) delete process.env.MOCK_PROFILE_UPLOAD;
    else process.env.MOCK_PROFILE_UPLOAD = originalMockFlag;
  });

  it('requires Passport JWT in production even when the mock flag is true', () => {
    process.env.NODE_ENV = 'production';
    process.env.MOCK_PROFILE_UPLOAD = 'true';
    const request: Record<string, unknown> = { params: { id: 'attacker-id' } };

    expect(new JwtAuthGuard().canActivate(mockContext(request))).toBe(false);
    expect(mockPassportCanActivate).toHaveBeenCalledTimes(1);
    expect(request.user).toBeUndefined();
  });

  it('requires Passport JWT in production when the mock flag is disabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.MOCK_PROFILE_UPLOAD = 'false';

    expect(new JwtAuthGuard().canActivate(mockContext({}))).toBe(false);
    expect(mockPassportCanActivate).toHaveBeenCalledTimes(1);
  });

  it('requires Passport JWT in development when the mock flag is disabled', () => {
    process.env.NODE_ENV = 'development';
    process.env.MOCK_PROFILE_UPLOAD = 'false';

    expect(new JwtAuthGuard().canActivate(mockContext({}))).toBe(false);
    expect(mockPassportCanActivate).toHaveBeenCalledTimes(1);
  });

  it('delegates authenticated requests to Passport and never derives identity from URL params', () => {
    process.env.NODE_ENV = 'production';
    process.env.MOCK_PROFILE_UPLOAD = 'true';
    mockPassportCanActivate.mockReturnValue(true);
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer valid.jwt.token' },
      params: { id: 'attacker-id' },
    };

    expect(new JwtAuthGuard().canActivate(mockContext(request))).toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('uses the mock only through the profile-picture guard in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.MOCK_PROFILE_UPLOAD = 'true';
    const request: Record<string, unknown> = { params: { id: 'profile-id' } };

    expect(
      new ProfilePictureAuthGuard().canActivate(mockContext(request)),
    ).toBe(true);
    expect(request.user).toEqual({
      userId: 'profile-id',
      publicKey: 'mock-public-key',
    });
    expect(mockPassportCanActivate).not.toHaveBeenCalled();
  });

  it('requires JWT on the profile-picture route outside the exact development environment', () => {
    process.env.NODE_ENV = 'staging';
    process.env.MOCK_PROFILE_UPLOAD = 'true';
    const request: Record<string, unknown> = { params: { id: 'profile-id' } };

    expect(
      new ProfilePictureAuthGuard().canActivate(mockContext(request)),
    ).toBe(false);
    expect(mockPassportCanActivate).toHaveBeenCalledTimes(1);
    expect(request.user).toBeUndefined();
  });

  it('requires JWT on other protected endpoints even in development with the mock enabled', () => {
    process.env.NODE_ENV = 'development';
    process.env.MOCK_PROFILE_UPLOAD = 'true';
    const request: Record<string, unknown> = { params: { id: 'attacker-id' } };

    expect(new JwtAuthGuard().canActivate(mockContext(request))).toBe(false);
    expect(mockPassportCanActivate).toHaveBeenCalledTimes(1);
    expect(request.user).toBeUndefined();
  });
});
