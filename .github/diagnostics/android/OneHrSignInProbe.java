package onehr.diagnostics;

import android.os.SystemClock;
import com.android.uiautomator.core.Configurator;
import com.android.uiautomator.core.UiObject;
import com.android.uiautomator.core.UiSelector;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;

/** Shell test utility, not app code. No hierarchy/screenshot/password/MFA reads. */
public final class OneHrSignInProbe extends UiAutomatorTestCase {
  private UiObject byText(String value) { return new UiObject(new UiSelector().textContains(value)); }
  private UiObject field(String label) { return new UiObject(new UiSelector().className("android.widget.EditText").description(label)); }
  private void setupBounded() {
    Configurator.getInstance().setWaitForIdleTimeout(0).setWaitForSelectorTimeout(2500).setActionAcknowledgmentTimeout(2500);
  }
  private String publicStage() {
    if (byText("Sign-in or recovery is temporarily unavailable").exists()) return "unavailable";
    if (byText("The organization, username or password is incorrect").exists()) return "invalidLogin";
    if (byText("Too many attempts").exists()) return "rateLimited";
    if (byText("Verify your sign-in").exists()) return "mfa";
    if (field("Username").exists()) return "login";
    return "unverifiedScreen";
  }
  public void testObserve() throws Exception {
    setupBounded();
    assertEquals("Wrong foreground app; do not act", "ai.stradaverse.aihr.test", getUiDevice().getCurrentPackageName());
    System.out.println("ONEHR_PROBE {\"kind\":\"publicAuthObservation\",\"stage\":\""+publicStage()+"\",\"credentialRead\":false}");
  }
  private String control(String label, UiObject object) throws Exception {
    if(!object.exists()) return "\""+label+"\":{\"exists\":false}";
    android.graphics.Rect r=object.getVisibleBounds();
    return "\""+label+"\":{\"exists\":true,\"enabled\":"+object.isEnabled()+",\"focused\":"+object.isFocused()+",\"bounds\":["+r.left+","+r.top+","+r.right+","+r.bottom+"]}";
  }
  public void testControls() throws Exception {
    setupBounded();
    assertEquals("Wrong foreground app; do not act", "ai.stradaverse.aihr.test", getUiDevice().getCurrentPackageName());
    UiObject submit=new UiObject(new UiSelector().description("Sign in"));
    System.out.println("ONEHR_PROBE {\"kind\":\"publicControlMetadata\",\"width\":"+getUiDevice().getDisplayWidth()+",\"height\":"+getUiDevice().getDisplayHeight()+","+control("username",field("Username"))+","+control("password",field("Password"))+","+control("submit",submit)+",\"fieldValuesRead\":false}");
  }
  public void testRestoreUsernameOnly() throws Exception {
    setupBounded();
    assertEquals("Wrong foreground app; do not act", "ai.stradaverse.aihr.test", getUiDevice().getCurrentPackageName());
    String restore=getParams().getString("restoreUsername", "");
    assertTrue(restore.matches("[A-Za-z0-9._@+-]{3,64}"));
    assertTrue("Not a login form",field("Username").exists());
    assertTrue(field("Username").setText(restore));
    assertEquals("Username must match exactly",restore,field("Username").getText());
    getUiDevice().pressBack();
    System.out.println("ONEHR_PROBE {\"kind\":\"publicUsernameRestoration\",\"exactMatch\":true,\"passwordOrMfaRead\":false,\"signInSubmitted\":false}");
  }
  /** Exercise the actual normal form with guaranteed-invalid syntax; never read a password. */
  public void testFixedInvalidLogin() throws Exception {
    setupBounded();
    UiSelector scope=new UiSelector().packageName("ai.stradaverse.aihr.test");
    UiObject username=new UiObject(scope.className("android.widget.EditText").description("Username"));
    UiObject password=new UiObject(scope.className("android.widget.EditText").description("Password"));
    UiObject organization=new UiObject(scope.textContains("Organization: aihr-test"));
    UiObject submit=new UiObject(scope.description("Sign in"));
    String restore=getParams().getString("restoreUsername", "");
    assertTrue(restore.matches("[A-Za-z0-9._@+-]{3,64}"));
    assertTrue("Expected signed staging workplace",organization.exists());
    assertTrue("Expected enabled normal login form",username.exists() && username.isEnabled() && password.exists() && password.isEnabled());
    boolean submitted=false,restored=false,cleared=false;
    String stage="not-submitted";
    try {
      assertTrue(username.setText("!diagnostic!"));
      assertTrue(password.setText("diagnostic-only"));
      long limit=SystemClock.uptimeMillis()+5000;
      while(SystemClock.uptimeMillis()<limit && !submit.isEnabled())SystemClock.sleep(100);
      assertTrue("Normal submit remains disabled",submit.isEnabled());
      assertTrue("Normal submit could not be clicked",submit.click());submitted=true;
      limit=SystemClock.uptimeMillis()+25000;
      while(SystemClock.uptimeMillis()<limit) {
        if(new UiObject(scope.textContains("The organization, username or password is incorrect")).exists()){stage="invalidLogin";break;}
        if(new UiObject(scope.textContains("Sign-in or recovery is temporarily unavailable")).exists()){stage="unavailable";break;}
        if(new UiObject(scope.textContains("Too many attempts")).exists()){stage="rateLimited";break;}
        SystemClock.sleep(200);
      }
      if(stage.equals("not-submitted"))stage="no-public-result";
    } finally {
      if(password.exists() && password.isEnabled())cleared=password.setText("");
      if(username.exists() && username.isEnabled()) {
        if(username.setText(restore))restored=restore.equals(username.getText());
      }
      System.out.println("ONEHR_FIXED_INVALID {\"submitted\":"+submitted+",\"stage\":\""+stage+"\",\"passwordClearedThroughNormalControl\":"+cleared+",\"knownUsernameRestoredExactly\":"+restored+",\"passwordOrMfaRead\":false}");
    }
    assertEquals("Expected native invalid-login refusal", "invalidLogin",stage);
    assertTrue("Restore only known nonsecret username",restored);
    assertTrue("Clear only synthetic password through normal control",cleared);
  }
  public void testScopedReviewState() throws Exception {
    setupBounded();
    UiSelector scope=new UiSelector().packageName("ai.stradaverse.aihr.test");
    UiObject username=new UiObject(scope.className("android.widget.EditText").description("Username"));
    UiObject report=new UiObject(scope.className("android.widget.TextView").description("Review connection diagnostic"));
    UiObject working=new UiObject(scope.text("Please wait…"));
    org.json.JSONObject state=new org.json.JSONObject();
    state.put("kind","scopedPublicReviewState");
    boolean login=username.exists();state.put("usernameControlPresent",login);
    if(login)state.put("usernameControlEnabled",username.isEnabled());
    state.put("workingLabelPresent",working.exists());
    state.put("reviewReportPresent",report.exists());
    state.put("fieldValuesRead",false);
    System.out.println("ONEHR_PROBE "+state.toString());
  }
  public void testClientDiagnostic() throws Exception {
    setupBounded();
    UiObject report=new UiObject(new UiSelector().packageName("ai.stradaverse.aihr.test").description("Review connection diagnostic").className("android.widget.TextView"));
    assertTrue("Review diagnostic not available",report.exists());
    org.json.JSONObject input=new org.json.JSONObject(report.getText());
    assertEquals("ONEHR_CLIENT_PROBE",input.optString("marker"));
    org.json.JSONObject output=new org.json.JSONObject();
    output.put("marker","ONEHR_CLIENT_PROBE");
    for(String key:new String[]{"realCredentialsUsed","configValid","decoderPresent","decoderWorks","bodyPresent","readerPresent","companyVerified","expectedInvalidLogin"}) {
      if(input.has(key)) { assertTrue(input.get(key) instanceof Boolean); output.put(key,input.getBoolean(key)); }
    }
    for(String key:new String[]{"companyStatus","loginStatus"}) {
      if(input.has(key)) { int status=input.getInt(key); assertTrue(status>=100 && status<=599);output.put(key,status); }
    }
    for(String key:new String[]{"outcome","phase","errorKind"}) {
      if(input.has(key)) {
        String value=input.getString(key);
        assertTrue(value.matches("pass|unexpected|fail|runtime|company-validation|company-fetch|company-body-or-metadata|invalid-login|login-fetch|login-body-or-refusal|body-read|reference|type|json-syntax|range|other"));
        output.put(key,value);
      }
    }
    if(input.has("publicTransportFailure")) {
      String detail=input.getString("publicTransportFailure");
      assertTrue(detail.length()<=240);
      assertFalse(detail.contains("http://")||detail.contains("https://")||detail.contains("@"));
      assertFalse(java.util.regex.Pattern.compile("\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b").matcher(detail).find());
      output.put("publicTransportFailure",detail);
    }
    System.out.println("ONEHR_CLIENT_PROBE "+output.toString());
  }

}
