import type { AdministrativeRole } from './PermissionService';

export interface RegionalAccessConfiguration {
  allowRegionalInheritance: boolean;
}

export function canInheritRegionalPermissions(
  role: AdministrativeRole,
  configuration: RegionalAccessConfiguration,
): boolean {
  if (role === 'COUNTRY_ADMIN') {
    return configuration.allowRegionalInheritance;
  }

  return false;
}
