package onehr.diagnostics;

import java.net.URI;
import java.net.URL;
import java.net.Proxy;
import java.net.InetSocketAddress;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** Standalone Android framework HTTPS diagnostic; no UI or private credentials. */
public final class NativeHttpsProbe {
  private static JSONObject request(String origin, String path, boolean post, Proxy proxy) throws Exception {
    long start=System.currentTimeMillis();
    JSONObject result=new JSONObject();
    result.put("stage",post?"invalidLoginControl":"publicCompanyConnection");
    HttpsURLConnection connection=null;
    try {
      URL url=new URL(origin+path);
      connection=(HttpsURLConnection)(proxy==null?url.openConnection():url.openConnection(proxy));
      connection.setConnectTimeout(8000);connection.setReadTimeout(8000);
      connection.setInstanceFollowRedirects(false);connection.setUseCaches(false);
      connection.setRequestProperty("accept","application/json");
      connection.setRequestProperty("x-aihr-client","native");
      if(post) {
        connection.setRequestMethod("POST");connection.setDoOutput(true);
        connection.setRequestProperty("content-type","application/json");
        byte[] body="{\"organization\":\"aihr-test\",\"username\":\"!diagnostic!\",\"password\":\"diagnostic-only\"}".getBytes("UTF-8");
        connection.setFixedLengthStreamingMode(body.length);
        connection.getOutputStream().write(body);connection.getOutputStream().close();
      }
      int status=connection.getResponseCode();result.put("status",status);
      InputStream stream=status>=400?connection.getErrorStream():connection.getInputStream();
      ByteArrayOutputStream bytes=new ByteArrayOutputStream();
      if(stream!=null) {
        byte[] chunk=new byte[1024];int count;
        while((count=stream.read(chunk))!=-1) {if(bytes.size()+count>32768)throw new Exception("BoundedPublicResponseExceeded");bytes.write(chunk,0,count);}
        stream.close();
      }
      result.put("bodyBytes",bytes.size());
      try {
        JSONObject body=new JSONObject(new String(bytes.toByteArray(),"UTF-8"));
        result.put("jsonResponse",true);
        result.put("expected",post?status==401&&"invalidLogin".equals(body.optString("error")):status==200&&origin.equals(body.optString("apiOrigin"))&&"internal".equals(body.optString("authProvider")));
      } catch(Exception ignored) {result.put("jsonResponse",false);result.put("expected",false);}
    } catch(Exception error) {
      result.put("exceptionClass",error.getClass().getSimpleName());
      result.put("causeClass",error.getCause()==null?"none":error.getCause().getClass().getSimpleName());
      result.put("expected",false);
    } finally {if(connection!=null)connection.disconnect();}
    result.put("elapsedMs",System.currentTimeMillis()-start);return result;
  }
  public static void main(String[] args) throws Exception {
    if(args.length<1||args.length>2)throw new IllegalArgumentException("Origin and optional owned proxy port only");
    URI uri=new URI(args[0]);
    if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||!(uri.getPath().isEmpty()||uri.getPath().equals("/")))throw new IllegalArgumentException("HTTPS origin required");
    String origin=args[0].replaceAll("/$","");Proxy proxy=null;
    if(args.length==2) {int port=Integer.parseInt(args[1]);if(port<1||port>65535)throw new IllegalArgumentException("Invalid owned proxy port");proxy=new Proxy(Proxy.Type.HTTP,new InetSocketAddress("10.0.2.2",port));}
    JSONObject result=new JSONObject();
    result.put("androidFrameworkHttps",true);result.put("explicitProxy",proxy!=null);
    result.put("company",request(origin,"/login/mobile-connection",false,proxy));
    result.put("login",request(origin,"/login/api/login",true,proxy));
    result.put("realCredentialsUsed",false);result.put("trustOrHostnameVerificationChanged",false);
    System.out.println("ONEHR_HTTPS "+result.toString());
  }
}
