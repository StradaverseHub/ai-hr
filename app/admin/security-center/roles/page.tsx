import AccessConfigurationPage from '@/app/admin/users/access/page';
import {requireAccessConfiguration} from '@/lib/access-configuration-authz';
export default async function RolesPage(){await requireAccessConfiguration();return AccessConfigurationPage();}
