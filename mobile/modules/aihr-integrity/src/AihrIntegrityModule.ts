import { NativeModule, requireNativeModule } from 'expo';

declare class AihrIntegrityModule extends NativeModule<{}> {
  hello(): string;
  setValueAsync(value: string): Promise<void>;
}

export default requireNativeModule<AihrIntegrityModule>('AihrIntegrity');
