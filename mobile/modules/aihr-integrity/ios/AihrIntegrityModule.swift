import ExpoModulesCore

public class AihrIntegrityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AihrIntegrity")

    Function("hello") {
      return "Hello world! 👋"
    }

    AsyncFunction("setValueAsync") { (value: String) in
    }
  }
}
