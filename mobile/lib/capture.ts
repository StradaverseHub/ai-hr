/** Foreground evidence only. No library access, background subscription, camera roll or biometric matching. */
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator,SaveFormat } from 'expo-image-manipulator';
import { Directory,File,Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { AppState } from 'react-native';
import type { LocalAttachment } from './journey-drafts';
import { t } from './i18n';
export async function capturePosition(){
  const permission=await Location.requestForegroundPermissionsAsync();
  if(permission.status!=='granted')throw new Error(t('locationPermission'));
  if(AppState.currentState!=='active')throw new Error(t('unlockContinue'));
  let timeout:ReturnType<typeof setTimeout>|undefined;
  const fix=await Promise.race([Location.getCurrentPositionAsync({accuracy:Location.Accuracy.High}),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error(t('locationTimeout'))),20000);})]).finally(()=>clearTimeout(timeout));
  if(fix.mocked)throw new Error(t('mockLocation'));
  const {latitude:lat,longitude:lng,accuracy}=fix.coords;
  if(accuracy==null||![lat,lng,accuracy].every(Number.isFinite)||Date.now()-fix.timestamp>120000)throw new Error(t('locationTimeout'));
  return {lat,lng,accuracy,sampledAt:fix.timestamp};
}
export async function capturePhoto():Promise<LocalAttachment|null>{
  const permission=await ImagePicker.requestCameraPermissionsAsync();
  if(!permission.granted)throw new Error(t('cameraPermission'));
  if(AppState.currentState!=='active')throw new Error(t('unlockContinue'));
  const result=await ImagePicker.launchCameraAsync({mediaTypes:['images'],cameraType:ImagePicker.CameraType.front,quality:.7,exif:false});
  if(result.canceled)return null;
  const original=result.assets[0];
  const image=ImageManipulator.manipulate(original.uri);
  let rendered:Awaited<ReturnType<typeof image.renderAsync>>|undefined;
  let temporary:File|undefined;
  try {
    image.resize(original.width>=original.height?{width:640}:{height:640});
    rendered=await image.renderAsync();
    const saved=await rendered.saveAsync({format:SaveFormat.JPEG,compress:.8});
    temporary=new File(saved.uri);
    if(!temporary.size||temporary.size>2*1024*1024)throw new Error(t('photoTooLarge'));
    const directory=new Directory(Paths.cache,'aihr-journeys');if(!directory.exists)directory.create({intermediates:true});
    const owned=new File(directory,randomUUID()+'.jpg');temporary.move(owned);temporary=undefined;
    return {uri:owned.uri,name:'attendance.jpg',mimeType:'image/jpeg',size:owned.size};
  } finally {
    image.release();rendered?.release();
    try{if(temporary?.exists)temporary.delete();}catch{}
    try{const source=new File(original.uri);if(source.exists)source.delete();}catch{}
  }
}
export function appendAttachment(form:FormData,key:string,file:LocalAttachment){
  // React Native's FormData file-part contract; do not set multipart Content-Type (fetch owns boundary).
  form.append(key,{uri:file.uri,name:file.name,type:file.mimeType} as unknown as Blob);
}
