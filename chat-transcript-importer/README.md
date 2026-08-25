# Chat Transcript Importer

Marinara Engine용 채팅 기록 Import 확장 프로그램입니다.

TXT, Excel (`.xlsx`), JSON 형식의 대화 기록을 Marinara 채팅으로 가져올 수 있으며, TXT 파일의 불필요한 메타데이터와 상태창 등을 Import 전에 정리할 수 있습니다.

**Version 1.4.1**

## 주요 기능

- TXT / XLSX / JSON 채팅 Import
- TXT 화자 및 턴 형식 자동 인식
- User / Assistant 역할 판정
- 원본 날짜 및 시간 보존
- Import 전 메시지 미리보기
- 메시지별 선택 및 제외
- TXT 메타데이터 자동 정리
- 상태창 제거 또는 날짜/시간만 보존
- 이미지 호출 및 HTML 주석 제거
- 빈 메시지 / 플레이스홀더 제거
- User 명령 및 OOC 전용 메시지 제거
- `{{char}}`, `{{user}}` 이름 자동 치환
- 정리 예정 항목 확인 및 개별 보존

## 설치

1. Marinara의 `.env`에 다음 설정을 추가합니다.

```env
ENABLE_EXTERNAL_EXTENSIONS=true
```

2. **Settings > Advanced > Danger Zone**에서 타사 확장 Import를 허용합니다.
3. **Settings > Addons > External Extensions**에서 배포 ZIP을 Import합니다.
4. 표시되는 권한과 코드를 확인한 뒤 확장을 승인합니다.
5. Chats 화면에서 Import 아이콘을 눌러 사용합니다.

## TXT Import

여러 종류의 채팅 로그 형식을 자동으로 인식합니다.

예:

```text
[2026. 7. 28. AM 9:02:52] 나: 사용자 메시지
[2026. 7. 28. AM 9:03:44] 캐릭터: 캐릭터 응답
```

```text
### 사용자
사용자 메시지

### 캐릭터
캐릭터 응답
```

```text
[턴 12]
사용자 메시지

---

캐릭터 응답
```

명시적인 역할 표시가 없는 TXT는 Import 화면의 역할 설정을 기준으로 User와 Assistant를 구분합니다.

## TXT 정리

TXT Import 시 다음과 같은 요소를 자동으로 감지하여 제거하거나 변환할 수 있습니다.

- 서비스 및 내보내기 메타데이터
- 빈 메시지 및 플레이스홀더
- 상태창
- 이미지 호출 및 Markdown 이미지
- HTML 주석
- 메시지 끝에 붙은 내보내기 날짜/시간
- `이어서`, 명령어, OOC 등 User 제어 메시지

자동으로 감지된 항목은 **정리 항목 검토**에서 확인할 수 있으며, 필요한 항목은 개별적으로 보존할 수 있습니다.

### 상태창

상태창은 다음 중 하나로 처리할 수 있습니다.

- 그대로 유지
- 전체 제거
- 날짜만 남기기
- 날짜 + 시간 남기기

날짜와 시간을 남기면 다음과 같이 변환됩니다.

```text
[11.03 | 23:15]
```

Markdown 코드블록, Status 태그, `<details>...</details>` 등으로 작성된 상태창을 지원합니다.

### 이름 치환

TXT 본문의:

```text
{{char}}
{{user}}
```

는 각각 Import 시 선택한 **캐릭터 이름**과 **페르소나 이름**으로 자동 치환됩니다.

## 메시지 선택

Import 전에 파싱된 메시지를 미리 확인할 수 있습니다.

불필요한 메시지는 체크를 해제하여 Import 대상에서 제외할 수 있으며 다음 빠른 선택 기능을 제공합니다.

- 전체 선택
- 전체 해제
- User만
- Assistant만

## Excel

첫 번째 워크시트에 다음 열을 사용합니다.

| role | content | name (선택) | timestamp (선택) |
| --- | --- | --- | --- |
| user | 사용자 메시지 | 사용자명 | ISO 8601 날짜 |
| assistant | 캐릭터 응답 | 캐릭터명 | ISO 8601 날짜 |

`role`과 `content`는 필수입니다.

## JSON

```json
{
  "messages": [
    {
      "role": "user",
      "content": "사용자 메시지"
    },
    {
      "role": "assistant",
      "content": "캐릭터 응답"
    }
  ]
}
```

## 제한사항

- 지원 형식: `.txt`, `.xlsx`, `.json`
- 최대 파일 크기: 20MB
- 최대 메시지 수: 10,000개
- Import 후 Chats 목록에 새 채팅이 바로 표시되지 않으면 페이지를 새로고침하세요.
- 특수한 TXT 형식은 Import 전에 미리보기와 정리 결과를 확인하는 것을 권장합니다.

## Privacy

선택한 채팅 파일은 외부 서비스로 전송하지 않습니다.

이 확장은 Marinara의 채팅 및 메시지 기능에 접근하기 위해 `full_page_access` 권한을 사용합니다.