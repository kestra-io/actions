{{ if not (eq . nil) }}
### 🚨 Vulnerabilities found

{{ range . }}
#### 🛡️ Vulnerability in: `{{ .Target }}`

| Vulnerability | Severity | Package | Installed Version | Fixed Version |
| :--- | :--- | :--- | :--- | :--- |
{{- range .Vulnerabilities }}
| [{{ .VulnerabilityID }}]({{ .PrimaryURL }}) | {{ .Severity }} | {{ .PkgName }} | {{ .InstalledVersion }} | {{ .FixedVersion }} |
{{- end }}
{{ end }}


<details>
<summary>Full JSON Report</summary>

```json
{{ . | toPrettyJson }}
```
</details>
{{end}}
