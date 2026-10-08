import {
  isProfilePictureMockEnabled,
  warnIfProfilePictureMockEnabled,
} from './profile-picture-mock.config';

describe('profile-picture mock configuration', () => {
  it('enables the mock only when development and the explicit flag are both set', () => {
    expect(
      isProfilePictureMockEnabled({
        NODE_ENV: 'development',
        MOCK_PROFILE_UPLOAD: 'true',
      }),
    ).toBe(true);
  });

  it.each([
    { NODE_ENV: 'production', MOCK_PROFILE_UPLOAD: 'true' },
    { NODE_ENV: 'test', MOCK_PROFILE_UPLOAD: 'true' },
    { NODE_ENV: 'staging', MOCK_PROFILE_UPLOAD: 'true' },
    { NODE_ENV: undefined, MOCK_PROFILE_UPLOAD: 'true' },
    { NODE_ENV: 'development', MOCK_PROFILE_UPLOAD: 'false' },
  ])('fails closed for $NODE_ENV / $MOCK_PROFILE_UPLOAD', (env) => {
    expect(isProfilePictureMockEnabled(env)).toBe(false);
  });

  it('warns only when the mock is actually active', () => {
    const warn = jest.fn<void, [string]>();
    const logger = { warn };

    warnIfProfilePictureMockEnabled(
      { NODE_ENV: 'development', MOCK_PROFILE_UPLOAD: 'true' },
      logger,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('exclusively for profile-picture uploads'),
    );

    warn.mockClear();
    warnIfProfilePictureMockEnabled(
      { NODE_ENV: 'production', MOCK_PROFILE_UPLOAD: 'true' },
      logger,
    );
    expect(warn).not.toHaveBeenCalled();

    warnIfProfilePictureMockEnabled(
      { NODE_ENV: 'development', MOCK_PROFILE_UPLOAD: 'false' },
      logger,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
