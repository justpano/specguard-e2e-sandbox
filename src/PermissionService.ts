export type AdministrativeRole = 'COUNTRY_ADMIN' | 'LOCAL_ADMIN';

/**
 * Country Admin accounts are intentionally isolated from permissions assigned to Local admins.
 */
export function canInheritLocalPermissions(role: AdministrativeRole): boolean {
  return role !== 'COUNTRY_ADMIN';
}
