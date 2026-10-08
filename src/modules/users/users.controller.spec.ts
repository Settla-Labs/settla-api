import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProfilePictureAuthGuard } from '../auth/profile-picture-auth.guard';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UploadFileInput } from '../file-storage/file-storage.service';
import { Request } from 'express';
import { GUARDS_METADATA } from '@nestjs/common/constants';

type UploadProfilePicRequest = Request & {
  user: { userId: string; publicKey: string };
};

describe('UsersController', () => {
  let controller: UsersController;
  let mockUsersService: {
    uploadProfilePicture: jest.Mock;
    findByPublicKey: jest.Mock;
    update: jest.Mock;
    exportUserData: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(async () => {
    mockUsersService = {
      uploadProfilePicture: jest.fn(),
      findByPublicKey: jest.fn(),
      update: jest.fn(),
      exportUserData: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: mockUsersService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ProfilePictureAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('uses the mock-capable guard only for the profile-picture endpoint', () => {
    const profilePictureMethod = Object.getOwnPropertyDescriptor(
      UsersController.prototype,
      'uploadProfilePicture',
    )?.value as object;
    const updateMethod = Object.getOwnPropertyDescriptor(
      UsersController.prototype,
      'update',
    )?.value as object;
    const profilePictureGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      profilePictureMethod,
    ) as unknown[];
    const updateGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      updateMethod,
    ) as unknown[];

    expect(profilePictureGuards).toContain(ProfilePictureAuthGuard);
    expect(profilePictureGuards).not.toContain(JwtAuthGuard);
    expect(updateGuards).toContain(JwtAuthGuard);
  });

  describe('uploadProfilePicture', () => {
    const mockRequest = (userId: string, publicKey?: string) =>
      ({
        user: { userId, publicKey: publicKey ?? 'G' + userId },
      }) as unknown as UploadProfilePicRequest;

    const mockFile: UploadFileInput = {
      originalname: 'test.png',
      mimetype: 'image/png',
      size: 1024,
      buffer: Buffer.from('test'),
    };

    it('should successfully upload profile picture', async () => {
      const expectedResponse = {
        userId: 'user-1',
        profileImageUrl: 'http://url',
      };
      mockUsersService.uploadProfilePicture.mockResolvedValue(expectedResponse);

      const result = await controller.uploadProfilePicture(
        'user-1',
        mockRequest('user-1'),
        undefined,
        mockFile,
      );

      expect(result).toEqual(expectedResponse);
      expect(mockUsersService.uploadProfilePicture).toHaveBeenCalledWith(
        'user-1',
        mockFile,
        undefined,
      );
    });

    it('should throw ForbiddenException if user tries to update another users profile', async () => {
      mockUsersService.findByPublicKey.mockResolvedValue(null);

      await expect(
        controller.uploadProfilePicture(
          'user-1',
          mockRequest('user-2'),
          undefined,
          mockFile,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException if no file is provided', async () => {
      await expect(
        controller.uploadProfilePicture(
          'user-1',
          mockRequest('user-1'),
          undefined,
          undefined as unknown as UploadFileInput,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if file is not an allowed image type', async () => {
      const invalidFile = { ...mockFile, mimetype: 'application/pdf' };

      await expect(
        controller.uploadProfilePicture(
          'user-1',
          mockRequest('user-1'),
          undefined,
          invalidFile,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if file is too large', async () => {
      const hugeFile = { ...mockFile, size: 10 * 1024 * 1024 }; // 10MB

      await expect(
        controller.uploadProfilePicture(
          'user-1',
          mockRequest('user-1'),
          undefined,
          hugeFile,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should parse userSnapshot JSON correctly', async () => {
      mockUsersService.uploadProfilePicture.mockResolvedValue({});

      await controller.uploadProfilePicture(
        'user-1',
        mockRequest('user-1'),
        '{"alias":"newalias"}',
        mockFile,
      );

      expect(mockUsersService.uploadProfilePicture).toHaveBeenCalledWith(
        'user-1',
        mockFile,
        { alias: 'newalias' },
      );
    });

    it('should throw BadRequestException if userSnapshot is invalid JSON', async () => {
      await expect(
        controller.uploadProfilePicture(
          'user-1',
          mockRequest('user-1'),
          'invalid-json',
          mockFile,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    it('passes the authenticated user id to the update service', () => {
      mockUsersService.update.mockReturnValue({
        userId: 'user-1',
        alias: 'new-alias',
      });
      const request = { user: { userId: 'user-1' } };

      const result: unknown = controller.update(
        'user-1',
        { alias: 'new-alias' },
        request as unknown as Parameters<typeof controller.update>[2],
      );

      expect(result).toEqual({ userId: 'user-1', alias: 'new-alias' });
      expect(mockUsersService.update).toHaveBeenCalledWith(
        'user-1',
        { alias: 'new-alias' },
        'user-1',
      );
    });

    it('falls back to id when a strategy exposes req.user.id', async () => {
      const request = { user: { id: 'user-1' } };

      await controller.update(
        'user-1',
        { alias: 'new-alias' },
        request as unknown as Parameters<typeof controller.update>[2],
      );

      expect(mockUsersService.update).toHaveBeenCalledWith(
        'user-1',
        { alias: 'new-alias' },
        'user-1',
      );
    });
  });

  describe('exportData', () => {
    it('passes the authenticated user id to the export service', async () => {
      mockUsersService.exportUserData.mockResolvedValue({ userId: 'user-1' });
      const request = { user: { userId: 'user-1' } };

      const result: unknown = await controller.exportData(
        'user-1',
        request as unknown as Parameters<typeof controller.exportData>[1],
      );

      expect(result).toEqual({ userId: 'user-1' });
      expect(mockUsersService.exportUserData).toHaveBeenCalledWith(
        'user-1',
        'user-1',
      );
    });
  });

  describe('remove', () => {
    it('passes the authenticated user id to the delete service', async () => {
      mockUsersService.remove.mockResolvedValue({
        userId: 'user-1',
        deletedAt: new Date(),
      });
      const request = { user: { userId: 'user-1' } };

      await controller.remove(
        'user-1',
        request as unknown as Parameters<typeof controller.remove>[1],
      );

      expect(mockUsersService.remove).toHaveBeenCalledWith('user-1', 'user-1');
    });
  });
});
