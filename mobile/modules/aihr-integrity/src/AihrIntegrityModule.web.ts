import { registerWebModule, NativeModule } from 'expo';

// AihrIntegrityModule is not available on the web platform.
class AihrIntegrityModule extends NativeModule<{}> {}

export default registerWebModule(AihrIntegrityModule, 'AihrIntegrityModule');
