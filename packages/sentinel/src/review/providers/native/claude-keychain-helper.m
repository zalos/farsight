// Fixed native login reader. No caller-chosen query, writes, refresh, login or interactive authentication.
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <sys/resource.h>
#include <pwd.h>
#include <unistd.h>
#include <math.h>
#include <string.h>

static int output(NSData *data) {
  const uint8_t *bytes = data.bytes;
  NSUInteger left = data.length;
  while (left) {
    ssize_t count = write(STDOUT_FILENO, bytes, left);
    if (count <= 0) return 74;
    bytes += count; left -= (NSUInteger)count;
  }
  return 0;
}

int main(int argc, const char *argv[]) {
  struct rlimit core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &core) != 0) return 70;
  @autoreleasepool {
    if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) return 77;
    Boolean allowed = true;
    if (SecKeychainGetUserInteractionAllowed(&allowed) != errSecSuccess || allowed) return 77;
    LAContext *context = [[LAContext alloc] init];
    context.interactionNotAllowed = YES;
    if (!context.interactionNotAllowed) return 77;
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
      struct rlimit observed;
      if (getrlimit(RLIMIT_CORE, &observed) != 0 || observed.rlim_cur != 0 || observed.rlim_max != 0) return 70;
      return output([@"{\"protocol\":\"claude-keychain-token/1\",\"noUi\":true,\"coreDisabled\":true}\n" dataUsingEncoding:NSUTF8StringEncoding]);
    }
    if (argc != 1) return 64;
    struct passwd *account = getpwuid(getuid());
    if (!account || !account->pw_name || strlen(account->pw_name) == 0 || strlen(account->pw_name) > 128) return 69;
    NSString *name = [NSString stringWithUTF8String:account->pw_name];
    if (!name) return 69;
    NSDictionary *query = @{
      (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService: @"Claude Code-credentials",
      (__bridge id)kSecAttrAccount: name,
      (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
      (__bridge id)kSecReturnData: @YES,
      (__bridge id)kSecUseAuthenticationContext: context
    };
    CFTypeRef found = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &found);
    if (status != errSecSuccess) {
      if (found) CFRelease(found);
      if (status == errSecInteractionNotAllowed || status == errSecAuthFailed) return 77;
      return status == errSecItemNotFound ? 69 : 70;
    }
    if (!found || CFGetTypeID(found) != CFDataGetTypeID()) { if (found) CFRelease(found); return 65; }
    NSData *item = CFBridgingRelease(found);
    if (item.length == 0 || item.length > 65536) return 65;
    id record = [NSJSONSerialization JSONObjectWithData:item options:0 error:nil];
    if (![record isKindOfClass:[NSDictionary class]]) return 65;
    id oauth = record[@"claudeAiOauth"];
    if (![oauth isKindOfClass:[NSDictionary class]]) return 65;
    id token = oauth[@"accessToken"], expiry = oauth[@"expiresAt"], scopes = oauth[@"scopes"];
    if (![token isKindOfClass:[NSString class]] || ![expiry isKindOfClass:[NSNumber class]] || ![scopes isKindOfClass:[NSArray class]]) return 65;
    NSData *tokenBytes = [token dataUsingEncoding:NSUTF8StringEncoding];
    if (tokenBytes.length == 0 || tokenBytes.length > 8192) return 65;
    const uint8_t *raw = tokenBytes.bytes;
    for (NSUInteger i = 0; i < tokenBytes.length; i++) if (raw[i] <= 0x20 || raw[i] >= 0x7f) return 65;
    double expires = [expiry doubleValue];
    if (!isfinite(expires) || floor(expires) != expires || expires > 9007199254740991.0
      || expires <= [[NSDate date] timeIntervalSince1970] * 1000 + 5000) return 65;
    NSSet *known = [NSSet setWithArray:@[@"user:inference", @"user:profile", @"user:sessions:claude_code", @"user:mcp_servers", @"user:file_upload",
      @"user:plugins", @"user:projects:read", @"user:projects:write", @"org:create_api_key", @"user:ccr_inference"]];
    if ([scopes count] == 0 || [scopes count] > known.count || ![scopes containsObject:@"user:inference"]) return 65;
    NSMutableSet *seen = [NSMutableSet set];
    for (id scope in scopes) {
      if (![scope isKindOfClass:[NSString class]] || ![known containsObject:scope] || [seen containsObject:scope]) return 65;
      [seen addObject:scope];
    }
    // Whole native JSON (which may contain refresh material) remains only in this short-lived helper.
    // The parent receives only access token + expiry + scopes. No erasure claim is made for framework buffers.
    NSData *result = [NSJSONSerialization dataWithJSONObject:@{@"claudeAiOauth":@{@"accessToken":token,@"expiresAt":expiry,@"scopes":scopes}} options:0 error:nil];
    if (!result || result.length > 65536) return 65;
    return output(result);
  }
}
