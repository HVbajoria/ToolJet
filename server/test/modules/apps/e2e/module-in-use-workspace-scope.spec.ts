import { INestApplication } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  initTestApp,
  closeTestApp,
  createUser,
  createApplication,
  createApplicationVersion,
  findEntityOrFail,
  saveEntity,
  updateEntity,
  getDefaultDataSource,
} from 'test-helper';
import { App } from '@entities/app.entity';
import { Page } from '@entities/page.entity';
import { Component } from '@entities/component.entity';
import { APP_TYPES } from '@modules/apps/constants';
import { AppsUtilService } from '@modules/apps/util.service';

/**
 * The module delete-in-use guard (AppsUtilService.checkModuleInUseByApps) must be
 * scoped to the module's own workspace.
 *
 * A module's co_relation_id is the stable identity shared across branches AND
 * git-cloned workspaces (module-ref.util.ts). So two workspaces connected to the
 * same git repo hold copies of the same module with the SAME co_relation_id.
 * Before this fix the guard matched ModuleViewer consumers by co_relation_id with
 * no organization filter, so deleting a module in workspace B was blocked by apps
 * in workspace A that referenced their own copy — the Porter report. The same
 * unscoped match also surfaced those cross-workspace apps as "Module in use"
 * conflicts when pulling.
 */
/** @group platform */
describe('Module delete-in-use guard — workspace scoping', () => {
  let nestApp: INestApplication;
  let service: AppsUtilService;

  // Shared git-stable identity of "the same module" cloned into both workspaces.
  const sharedCoRelationId = uuidv4();

  let moduleInWorkspaceA: App;
  let moduleInWorkspaceB: App;

  beforeAll(async () => {
    ({ app: nestApp } = await initTestApp());
    service = nestApp.get(AppsUtilService);

    // ── Workspace A: the module plus an app that embeds it ──────────────────
    const { user: userA } = await createUser(nestApp, {
      email: 'portera@tooljet.com',
      organizationName: 'Workspace A',
    });

    moduleInWorkspaceA = await createApplication(nestApp, {
      name: 'Shared module',
      user: userA,
      type: APP_TYPES.MODULE,
    });
    await updateEntity(App, moduleInWorkspaceA.id, { co_relation_id: sharedCoRelationId });
    moduleInWorkspaceA.co_relation_id = sharedCoRelationId;

    const consumerApp = await createApplication(nestApp, {
      name: 'Consumer app in A',
      user: userA,
      type: APP_TYPES.FRONT_END,
    });
    const consumerVersion = await createApplicationVersion(nestApp, consumerApp as App & { organizationId: string });
    const consumerPage = await findEntityOrFail(Page, { appVersionId: consumerVersion.id } as any);
    await saveEntity(Component, {
      name: 'moduleViewer1',
      type: 'ModuleViewer',
      pageId: consumerPage.id,
      properties: {
        moduleAppId: { value: sharedCoRelationId },
        moduleVersionId: { value: '' },
      },
      general: {},
      styles: {},
      generalStyles: {},
      validation: {},
    } as any);

    // ── Workspace B: the git-cloned copy of the same module, no consumers ───
    const { user: userB } = await createUser(nestApp, {
      email: 'porterb@tooljet.com',
      organizationName: 'Workspace B',
    });
    moduleInWorkspaceB = await createApplication(nestApp, {
      name: 'Shared module',
      user: userB,
      type: APP_TYPES.MODULE,
    });
    await updateEntity(App, moduleInWorkspaceB.id, { co_relation_id: sharedCoRelationId });
    moduleInWorkspaceB.co_relation_id = sharedCoRelationId;
  });

  afterAll(async () => {
    await closeTestApp(nestApp);
  }, 60_000);

  it('does NOT block deleting the module in workspace B for a consumer that lives in workspace A', async () => {
    await expect(
      service.checkModuleInUseByApps(moduleInWorkspaceB, getDefaultDataSource().manager)
    ).resolves.toBeUndefined();
  });

  it('still blocks deleting the module in workspace A, whose own app embeds it', async () => {
    await expect(service.checkModuleInUseByApps(moduleInWorkspaceA, getDefaultDataSource().manager)).rejects.toThrow(
      'Cannot delete this module'
    );
  });
});
