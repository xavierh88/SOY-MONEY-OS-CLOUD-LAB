import { expect, test } from '@playwright/test';
import { installFixtureApi, type FixtureState } from './fixtures';

let fixtureState: FixtureState;
test.beforeEach(async ({ page }) => {
  fixtureState = await installFixtureApi(page);
  await page.goto('/');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
});

test('landing page and auth boundary never require real Clerk credentials', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'El dinero está en las señales.' })).toBeVisible();
  await page.getByTestId('button-sign-in').click();
  await expect(page.getByTestId('button-e2e-sign-in')).toBeVisible();

  await page.goto('/user-portal');
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/sign-in');
  await page.getByTestId('button-e2e-sign-in').click();
  await expect(page).toHaveURL(/\/user-portal$/);
});

test('dashboard, discovery fixture, evidence, and owner review', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByTestId('button-e2e-sign-in').click();
  await expect(page.getByRole('heading', { name: 'El dinero está en las señales.' })).toBeVisible();

  await page.getByTestId('link-see-opportunities').click();
  await expect(page.getByRole('heading', { name: 'Oportunidades' })).toBeVisible();
  await expect(page.getByText('Cobro simple para clínicas')).toBeVisible();
  await page.getByTestId('card-opportunity-1').click();
  await expect(page.getByRole('heading', { name: 'Cobro simple para clínicas' })).toBeVisible();
  await page.getByRole('button', { name: /Evidencia/ }).click();
  await expect(page.getByText('Las clínicas reportan conciliación manual de pagos.')).toBeVisible();

  await page.goto('/configuracion');
  await expect(page.getByText('Decisiones pendientes')).toBeVisible();
  await page.getByTestId('button-approve-setting-10').click();
  await expect(page.getByText('Sin señales todavía')).toBeVisible();

  await page.reload();
  await expect(page.getByText('Sin señales todavía')).toBeVisible();
});

test('owner can reject a pending review without external side effects', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByTestId('button-e2e-sign-in').click();
  await page.goto('/configuracion');
  await page.getByTestId('button-reject-10').click();
  await expect(page.getByText('Sin señales todavía')).toBeVisible();
});

test('project, QA state, results, and principal API error state', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByTestId('button-e2e-sign-in').click();
  await page.goto('/proyectos');
  await expect(page.getByRole('heading', { name: 'Proyectos' })).toBeVisible();
  await page.getByTestId('card-project-1').click();
  await expect(page.getByRole('heading', { name: 'Cobro simple para clínicas · MVP' })).toBeVisible();
  await expect(page.getByText('Control de Calidad Funcional')).toBeVisible();
  await expect(page.getByText('QA: PASSED')).toBeVisible();

  await page.goto('/resultados');
  await expect(page.getByRole('heading', { name: 'Resultados' })).toBeVisible();
  await expect(page.getByText('Interés inicial positivo; no es una venta real.')).toBeVisible();

  await page.route('**/api/dashboard', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'fixture dashboard unavailable' }),
    });
  });
  await page.goto('/user-portal');
  await expect(page.getByTestId('state-error')).toBeVisible({ timeout: 12_000 });
  await expect(page.getByText('No se pudo cargar este registro')).toBeVisible();
});

test('desktop and mobile layouts retain navigation access', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByTestId('button-e2e-sign-in').click();
  await expect(page.locator('.sidebar')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('button-toggle-menu')).toBeVisible();
  await page.getByTestId('button-toggle-menu').click();
  await expect(page.locator('.sidebar.sidebar-open')).toBeVisible();
  await page.getByTestId('link-nav-oportunidades').click();
  await expect(page.getByRole('heading', { name: 'Oportunidades' })).toBeVisible();
});