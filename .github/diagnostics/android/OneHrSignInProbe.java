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
  private void keyboardText(UiObject object,String value) throws Exception {
    assertTrue("Expected scoped control",object.exists() && object.isEnabled());
    assertTrue("Focus scoped control",object.click());
    assertTrue(getUiDevice().pressKeyCode(android.view.KeyEvent.KEYCODE_A,android.view.KeyEvent.META_CTRL_ON));
    assertTrue(getUiDevice().pressDelete());
    if(!value.isEmpty()) {
      Process input=new ProcessBuilder("/system/bin/input","text",value).start();
      assertTrue("Normal keyboard input bounded",input.waitFor(8,java.util.concurrent.TimeUnit.SECONDS));
      assertEquals("Normal keyboard input succeeded",0,input.exitValue());
    }
    SystemClock.sleep(300);
  }
  /** Exercise the actual normal form with guaranteed-invalid syntax; never read a password. */
  public void testFixedInvalidLogin() throws Exception {
    System.out.println("ONEHR_FORM_STEP starting"); System.out.flush();
    setupBounded();
    UiSelector scope=new UiSelector().packageName("ai.stradaverse.aihr.test");
    UiObject username=new UiObject(scope.className("android.widget.EditText").description("Username"));
    UiObject password=new UiObject(scope.className("android.widget.EditText").description("Password"));
    UiObject organization=new UiObject(scope.text("Organization code: aihr-test"));
    UiObject submit=new UiObject(scope.description("Sign in"));
    String restore=getParams().getString("restoreUsername", "");
    assertTrue(restore.matches("[A-Za-z0-9._@+-]{3,64}"));
    System.out.println("ONEHR_FORM_STEP staging-guard"); System.out.flush();
    assertTrue("Expected signed staging workplace",organization.exists());
    assertTrue("Expected enabled normal login form",username.exists() && username.isEnabled() && password.exists() && password.isEnabled());
    boolean submitted=false,restored=false,cleared=false;
    String stage="not-submitted";
    try {
      System.out.println("ONEHR_FORM_STEP enter-fixed-username"); System.out.flush();
      keyboardText(username,"!diagnostic!");
      System.out.println("ONEHR_FORM_STEP enter-synthetic-password"); System.out.flush();
      keyboardText(password,"diagnostic-only");
      UiObject keyboard=new UiObject(new UiSelector().packageNameMatches("com[.](google[.])?android[.]inputmethod[.].*"));
      if(keyboard.exists())getUiDevice().pressBack();
      System.out.println("ONEHR_FORM_STEP verify-submit"); System.out.flush();
      long limit=SystemClock.uptimeMillis()+5000;
      while(SystemClock.uptimeMillis()<limit && !submit.isEnabled())SystemClock.sleep(100);
      assertTrue("Normal submit remains disabled",submit.isEnabled());
      assertEquals("Only deliberately invalid username may be submitted", "!diagnostic!", username.getText());
      assertTrue("Normal submit could not be clicked",submit.click());submitted=true;
      System.out.println("ONEHR_FORM_STEP awaiting-public-result"); System.out.flush();
      limit=SystemClock.uptimeMillis()+25000;
      while(SystemClock.uptimeMillis()<limit) {
        if(new UiObject(scope.textContains("The organization, username or password is incorrect")).exists()){stage="invalidLogin";break;}
        if(new UiObject(scope.textContains("Sign-in or recovery is temporarily unavailable")).exists()){stage="unavailable";break;}
        if(new UiObject(scope.textContains("Too many attempts")).exists()){stage="rateLimited";break;}
        SystemClock.sleep(200);
      }
      if(stage.equals("not-submitted"))stage="no-public-result";
    } finally {
      System.out.println("ONEHR_FORM_STEP clearing-synthetic-input"); System.out.flush();
      if(password.exists() && password.isEnabled()){keyboardText(password,"");cleared=true;}
      if(username.exists() && username.isEnabled()) {
        keyboardText(username,restore);restored=restore.equals(username.getText());
      }
      System.out.println("ONEHR_FIXED_INVALID {\"submitted\":"+submitted+",\"stage\":\""+stage+"\",\"passwordClearedThroughNormalControl\":"+cleared+",\"knownUsernameRestoredExactly\":"+restored+",\"passwordOrMfaRead\":false}");
    }
    assertEquals("Expected native invalid-login refusal", "invalidLogin",stage);
    assertTrue("Restore only known nonsecret username",restored);
    assertTrue("Clear only synthetic password through normal control",cleared);
  }
  private static final class ScopedNode extends UiObject {
    ScopedNode(UiSelector selector){super(selector);}
    android.view.accessibility.AccessibilityNodeInfo node(){return findAccessibilityNodeInfo(0);}
  }
  private android.view.accessibility.AccessibilityNodeInfo labelNode(String label) {
    android.view.accessibility.AccessibilityNodeInfo n=new ScopedNode(new UiSelector().packageName("ai.stradaverse.aihr.test").description(label)).node();
    if(n==null)n=new ScopedNode(new UiSelector().packageName("ai.stradaverse.aihr.test").text(label)).node();
    return n;
  }
  private boolean signedShell() {
    for(String label:new String[]{"Home","Clock","Leave","Approvals","Me"}) {
      android.view.accessibility.AccessibilityNodeInfo n=labelNode(label);
      if(n==null || !n.isVisibleToUser())return false;
    }
    return true;
  }
  public void testNavigateReadonly() throws Exception {
    setupBounded();
    String label=getParams().getString("destination", "");
    assertTrue(java.util.Arrays.asList("Home","Clock","Leave","Approvals","Me","My profile","Attendance","Inbox","Settings","Leave history","Back").contains(label));
    android.view.accessibility.AccessibilityNodeInfo n=labelNode(label);
    boolean found=n!=null && n.isEnabled() && n.isVisibleToUser();
    if(found)for(int i=0;i<3 && (n.getActions() & android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)==0;i++) {
      android.view.accessibility.AccessibilityNodeInfo parent=n.getParent();
      if(parent==null || !"ai.stradaverse.aihr.test".contentEquals(parent.getPackageName()))break;
      n=parent;
    }
    boolean supported=found && (n.getActions() & android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)!=0;
    boolean acted=supported && n.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK);
    org.json.JSONObject out=new org.json.JSONObject();out.put("destination",label);out.put("found",found);out.put("clickSupported",supported);out.put("activated",acted);
    System.out.println("ONEHR_READONLY_NAV "+out.toString());
    assertTrue("Known read-only navigation action",acted);
  }
  public void testReadSignedinText() throws Exception {
    setupBounded();org.json.JSONObject out=new org.json.JSONObject();boolean allowed=signedShell();out.put("signedInShellVerified",allowed);
    out.put("inputValuesRead",false);org.json.JSONArray rows=new org.json.JSONArray();
    if(allowed)for(int i=0;i<120;i++) {
      android.view.accessibility.AccessibilityNodeInfo n=new ScopedNode(new UiSelector().packageName("ai.stradaverse.aihr.test").className("android.widget.TextView").instance(i)).node();
      if(n==null)break;
      if(n.isPassword() || !n.isVisibleToUser())continue;
      CharSequence text=n.getText();if(text==null || text.length()==0)continue;
      android.graphics.Rect r=new android.graphics.Rect();n.getBoundsInScreen(r);org.json.JSONObject row=new org.json.JSONObject();row.put("text",text.toString().substring(0,Math.min(text.length(),500)));row.put("bounds",new org.json.JSONArray(new int[]{r.left,r.top,r.right,r.bottom}));rows.put(row);
    }
    out.put("text",rows);System.out.println("ONEHR_SIGNEDIN_TEXT "+out.toString());
  }
  public void testScrollSignedin() throws Exception {
    setupBounded();assertTrue("Only signed-in review pages",signedShell());String direction=getParams().getString("direction","forward");assertTrue(direction.equals("forward") || direction.equals("backward"));
    android.view.accessibility.AccessibilityNodeInfo n=new ScopedNode(new UiSelector().packageName("ai.stradaverse.aihr.test").scrollable(true)).node();
    int action=direction.equals("forward")?android.view.accessibility.AccessibilityNodeInfo.ACTION_SCROLL_FORWARD:android.view.accessibility.AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
    boolean moved=n!=null && n.isEnabled() && n.isVisibleToUser() && n.performAction(action);
    System.out.println("ONEHR_READONLY_SCROLL {\"activated\":"+moved+"}");
  }
  public void testCompareUsernameOnly() throws Exception {
    setupBounded();
    String expected=getParams().getString("expectedUsername", "");
    assertTrue(expected.equals("!diagnostic!") || expected.matches("[A-Za-z0-9._@+-]{3,64}"));
    UiObject username=new UiObject(new UiSelector().packageName("ai.stradaverse.aihr.test").className("android.widget.EditText").description("Username"));
    boolean exists=username.exists();
    boolean match=exists && expected.equals(username.getText());
    System.out.println("ONEHR_USERNAME_MATCH {\"exists\":"+exists+",\"matchesExpected\":"+match+",\"passwordOrMfaRead\":false}");
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
