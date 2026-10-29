import type {Capture} from './capture.ts';
export type ScreenshotToolResult = {content: ({type:'text';text:string}|{type:'image';data:string;mimeType:'image/png'})[];isError?:boolean};
export function screenshotResult(shot:Capture):ScreenshotToolResult {
 return shot.ok ? {content:[{type:'image',data:shot.base64,mimeType:'image/png'}]}
 : {content:[{type:'text',text:shot.error}],isError:true};
}
