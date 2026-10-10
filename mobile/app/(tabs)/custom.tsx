import { useLocalSearchParams } from 'expo-router';
import { ComposedPage } from '../../lib/composed-page';
import { useTenantDesign } from '../../lib/design';
import { Redirect } from 'expo-router';
export default function Custom() { const { id } = useLocalSearchParams<{id: string}>(), {design} = useTenantDesign(); return design.schemaVersion === 2 ? <ComposedPage key={id} design={design} id={id} /> : <Redirect href="/" />; }
