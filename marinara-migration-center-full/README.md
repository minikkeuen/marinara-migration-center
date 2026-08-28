# 마리나라 이식 센터

Marinara Engine용 채팅 기록 Import 확장 프로그램입니다.

TXT, Excel (`.xlsx`), JSON 형식의 대화 기록을 Marinara 채팅으로 가져올 수 있으며, TXT 파일의 불필요한 메타데이터와 상태창 등을 Import 전에 정리할 수 있습니다.

**Version 1.0.1**

API/schema 기준 확인: Marinara Engine 2.4.4 소스. Character-Lorebook 연결에는 공식 `embedded-lorebook/embed` 경로가 필요합니다.

## 주요 기능

- TXT / XLSX / JSON 채팅 Import
- TXT 화자 및 턴 형식 자동 인식
- User / Assistant 역할 판정
- 원본 날짜 및 시간 보존
- Import 전 메시지 미리보기
- 메시지별 선택 및 제외
- Character 없이 일반 Conversation Chat Import
- TXT 메타데이터 자동 정리
- 상태창 제거 또는 날짜/시간만 보존
- 이미지 호출 및 HTML 주석 제거
- 빈 메시지 / 플레이스홀더 제거
- User 명령 및 OOC 전용 메시지 제거
- `{{char}}`, `{{user}}` 이름 자동 치환
- 정리 예정 항목 확인 및 개별 보존
- Combined / Separated 외부 프롬프트 입력
- 현재 대화의 최근 N턴 또는 전체 범위를 Chunk Extraction / Reduce로 분석
- 사용자가 검토·수정할 수 있는 대화 분석 기반 프롬프트 생성
- Marinara LLM Connection 기반 Character / Lorebook / Preset 후보 draft 변환
- 영구 저장되는 AI generation / Analyzer Prompt / Output Instructions 설정
- JSON 검증, 설정 가능한 유한 자동 교정, 편집 가능한 Review
- 마지막 분석 결과와 Review 수정 내용을 다시 여는 작업소
- 자동저장과 분리된 다중 Saved Draft 보관·열기·이름 변경·삭제
- Review 확정값을 공식 API로 Character와 Lorebook에 저장
- 새 Lorebook 생성, 기존 Lorebook에 추가, 사용자 확인 기반 Entry 병합
- 부분 실패 결과와 실패 항목 재시도, 동일 Review 중복 저장 방지

## 설치

1. Marinara의 `.env`에 다음 설정을 추가합니다.

```env
ENABLE_EXTERNAL_EXTENSIONS=true
```

2. **Settings > Advanced > Danger Zone**에서 타사 확장 Import를 허용합니다.
3. **Settings > Addons > External Extensions**에서 배포 ZIP을 Import합니다.
4. 표시되는 권한과 코드를 확인한 뒤 확장을 승인합니다.
5. Chats 화면에서 **마리나라 이식 센터** 아이콘을 누릅니다.
6. 통합 화면에서 **대화 가져오기**, **프롬프트 이식**, **작업소**, **설정**을 선택합니다.

## Prompt Conversion

외부 플랫폼 프롬프트를 적용 범위에 따라 Marinara용 Character, Lorebook, Preset 후보와 Residual Instructions draft로 분류합니다. AI draft는 바로 저장하지 않으며 사용자가 Review에서 확정한 Character와 Lorebook/Entry 값만 실제 Marinara 자산으로 저장합니다. Preset 후보와 Residual Instructions는 자동 저장하지 않습니다.

- **원본 보존 (Preserve)**: 기본 모드입니다. 영어로 번역·분류하되 정보, 강도, 조건, 예외와 의도적인 강조를 보존하고 필요한 만큼만 재구성합니다.
- **자연어 최적화 (Normalize)**: 기본 결과는 영어이며, 원본에 없는 설정을 만들지 않고 키워드·메모식 표현을 현대 LLM이 이해하기 좋은 자연어로 재작성합니다.

- **Combined**: 전체 프롬프트를 하나의 입력창에 입력합니다.
- **Separated**: Character, World / Lore, System / Style, Other 출처를 나누어 입력합니다.
- **로어북 입력 추가**: Combined와 Separated 모두에서 외부 플랫폼의 별도 Lorebook 자산을 일반 Prompt 및 기존 World / Lore와 구분된 독립 Source로 추가합니다. 이 Source는 기본적으로 Lorebook/Entry 생성에만 사용하며, 여기에만 존재하는 캐릭터 서술로 Character Draft를 확장하지 않습니다. Original Prompt의 Character 정보는 Lorebook 해석에 사용할 수 있고, Source 간 중복 사실은 Character와 Lorebook에 이중 생성하지 않습니다. 옵션을 꺼도 입력값은 현재 작업과 Saved Draft에 유지되며, 다시 켜기 전에는 Analyzer로 전달하지 않습니다.
- **대화 내역 참조**: 기본값은 OFF입니다. ON으로 켜면 기본적으로 **대화 가져오기**에서 현재 선택된 메시지를 사용하며, 필요하면 **채팅방 선택**에서 저장된 Marinara 채팅을 직접 선택할 수 있습니다. 최근 N턴 또는 전체 대화를 선택하며 최근 Turn부터 예상 토큰을 누적해 약 100K에 도달하는 범위를 권장합니다.
- **대화 분석 기반 프롬프트**: 선택 범위를 메시지·턴 경계를 우선해 token 기준 Chunk로 나눈 뒤 재사용 가능한 Character·관계·세계 정보를 추출하고 통합합니다. 결과는 일반 textarea에서 확인·수정·삭제할 수 있으며 제목과 레이블에 원본과 무관한 굵게·기울임 등의 장식 강조를 추가하지 않습니다.

채팅방 목록은 `CONVO`, `RP`, `GAME`으로 모드를 구분합니다. 같은 분기 그룹은 `원본`, `분기 N: 분기 이름`을 함께 표시하므로 이름이 같은 채팅방도 구분할 수 있습니다. **전체 대화**는 자동 요약 등으로 향후 generation context에서만 제외된 `hiddenFromAI` 과거 메시지도 원래 transcript의 일부로 포함하며, 사용자 transcript 자체에서 숨겨진 `hiddenFromUser` 메시지는 제외합니다.

UI의 수치는 실제 billing token이 아닌 범위 선택과 Chunking용 **예상 토큰**입니다. Latin·숫자는 약 4자, Hangul은 약 2자, Han·Kana는 약 1.5자를 1 token으로 보고 문자 종류별 값을 합산한 뒤 약 10% safety margin을 적용합니다. 기타 기호와 문자는 보수적으로 계산합니다. 메시지별 예상값은 한 번 계산해 Turn·범위·Chunk 계산에 재사용합니다. 권장 턴 수는 최근 Turn부터 예상 토큰을 누적해 약 100K에 도달하는 범위이며, 전체 대화가 그보다 짧으면 평균 예상 토큰/turn으로 필요한 턴 수를 외삽하므로 실제 보유 턴 수로 잘리지 않습니다. 실제 최근 N턴 입력만 현재 대화 범위 안으로 제한합니다. Chunk 예산은 선택한 Connection의 `maxContext`, Analyzer 지침, 원본 프롬프트, 예상 출력과 안전 여유를 고려합니다. UI의 **N회 나눠서 분석** 표시는 각 Chunk의 Extraction과 Reduce를 하나의 대화 분석 세트로 묶어 계산합니다. 권장량을 넘겨도 실행을 막지 않지만 비용과 시간이 늘어날 수 있습니다. 관계 변화 과정은 기본적으로 보존하며 옵션을 끄면 현재 관계 상태를 우선합니다.

대화 분석은 Character/Lorebook을 직접 만들지 않습니다. 생성된 대화 분석 기반 프롬프트를 원본 프롬프트와 별도 Source로 기존 Prompt Conversion에 전달하며, 원본이 비어 있어도 대화 분석 기반 프롬프트만으로 변환할 수 있습니다. 대화 내역 참조를 OFF로 바꾸면 생성된 내용은 작업 session에 유지하되 최종 변환 입력에서는 제외합니다. 사용자가 결과를 수정한 뒤 재분석하면 교체 전 확인합니다.

Marinara connections API에서 모델이 설정된 텍스트 생성 Connection만 표시하고, 선택한 Connection으로 raw generation API를 호출합니다. 기본적으로 Connection의 generation 설정을 사용하며 Temperature와 Max output tokens는 사용자가 override를 켠 경우에만 요청에 추가합니다. 응답 제한 시간이 지나면 현재 raw generation run을 중단합니다. API key는 Marinara가 관리하며 확장은 읽거나 저장하지 않습니다.

**AI 설정**에서는 생성 설정 재정의, 응답 제한 시간, JSON 교정 횟수, 최종 JSON 값의 표현 방식을 조절하는 **내용 및 형식 지침**, 그리고 **언어 고유 표현 보존**을 수정할 수 있습니다. 분석 정책과 JSON schema는 확장에 고정되어 사용자 지침으로 덮어쓸 수 없습니다. 언어 표현 보존 옵션은 기본적으로 꺼져 있으며, 켠 경우에만 번역으로 의미가 손실되는 말투·호칭·언어 고유 표현을 원어와 함께 선택적으로 유지합니다. AI 설정은 작업 session과 별도의 확장 전용 `marinara.storage` 키에 저장됩니다. 사용자 지침 또는 전체 설정을 1.0.1 기본값으로 복원할 수 있습니다.

Prompt Conversion의 마지막 작업 1개는 확장 전용 working session으로 자동 저장됩니다. Original/Separated 입력, 변환 모드와 AI 설정, Connection 선택, 대화 참조 설정과 선택 ID, 대화 분석 기반 프롬프트, AI draft, Review 수정 및 제외 상태를 복원합니다. 로어북 병합 분석을 마친 경우 선택 로어북, 분석 지문, 항목별 action·매칭 ID·제안 사유·경고·최종 편집값도 함께 복원합니다. 다시 불러온 대상 로어북이나 초안이 저장 당시와 다르면 기존 병합 결과를 stale 처리하고 재분석을 요구합니다. 입력 변경은 600ms debounce 후 저장하며 창을 닫을 때 남은 변경을 한 번 더 저장합니다. `작업 초기화`는 이 session만 지우고 AI Settings, Saved Draft, 실제 Marinara 자산에는 영향을 주지 않습니다. 자동저장 데이터가 약 900KB 예산을 넘으면 기존 working session을 덮어쓰지 않고 UI에 오류를 표시합니다.

**Saved Drafts**는 자동저장과 분리된 명시적 보관본입니다. `Draft 저장`으로 현재 snapshot을 새로 보관하고, 열어 둔 저장본은 `Draft 업데이트`를 눌러야 변경됩니다. 저장 개수와 만료 기한은 두지 않으며 사용자가 직접 열기, 이름 변경, 삭제를 실행합니다. 작업소의 목록은 기본적으로 닫혀 있습니다. 다른 Draft 열기, 새 분석, 작업 초기화처럼 현재 내용을 교체하는 동작은 미저장 변경이 있으면 저장·버리기·취소를 선택하게 합니다. Imported conversation 원문은 보관본마다 중복 저장하지 않습니다.

상단 **작업소**에서는 마지막 working session의 AI draft와 Review 수정 상태를 다시 열고 Saved Draft 목록을 관리합니다. 현재 분석 결과가 없으면 빈 상태와 프롬프트 이식 이동 버튼을 표시합니다. Saved Draft와 실제 Character/Lorebook 자산은 서로 다른 데이터입니다.

1.0.1 고정 분석기 프롬프트는 원본 프롬프트를 명령이 아닌 신뢰할 수 없는 분석 데이터로 취급합니다. 단순 문자열 유사성으로 정보를 제거하지 않고 강도·조건·예외·의도적인 강조를 의미의 일부로 처리합니다. 해결할 수 없는 모순은 임의로 선택하지 않고 경고로 올리며, 초안 작성 후 원본과 다시 대조해 누락·창작·강도 변화·잘못 제거된 강조를 점검하도록 지시합니다. JSON 전용 출력 규칙과 schema도 고정됩니다. 응답에서 JSON 코드 블록을 제거한 뒤 필수 객체, 필드 타입, 로어북 분류, 항목 배열, 프리셋 후보, 빈 결과를 검증합니다. 검증 실패 시 설정된 횟수만큼 JSON 교정을 요청하고, 그래도 실패하면 원본과 마지막 교정 응답을 표시합니다. 교정 횟수는 0~5회로 제한됩니다.

Review에서는 Character 주요 필드, Lorebook 이름·설명·category, Entry 내용·keys·boolean 설정·제외 여부, Preset 후보, residual instructions와 warnings를 수정할 수 있습니다. 프리셋 후보는 작업소에서 기본적으로 접혀 있으며 제목을 눌러 열어 확인·수정합니다. 최초 Prompt 분석은 비교 대상이 없는 로어북 통합 제안을 만들지 않습니다. 사용자가 `기존 로어북과 항목 단위 병합`을 선택하고 실제 로어북을 불러온 뒤 `AI 병합 분석`을 실행하면 별도 요청으로 Entry별 제안을 만듭니다. 병합 Review에서는 기존 Entry의 content, keys, secondaryKeys를 Draft와 함께 표시하고 action, 대상 Entry, 최종 저장 값을 사용자가 확인해야 합니다. 충돌이 없고 필요한 대상 항목이 모두 선택된 경우 `전체 결정 확인`으로 모든 결정을 한 번에 체크할 수 있습니다. Draft나 기존 Entry가 바뀌면 이전 제안은 무효화됩니다.

## Character / Lorebook 저장

Character는 `POST /api/characters`의 Character Card V2 `data` 본문으로 생성합니다. 비어 있는 선택 필드는 확장에서 임의로 채우지 않으며 Engine schema 기본값을 사용합니다. 새 Lorebook은 Character 전용 `category: character`, `isGlobal: false`, `characterIds: [생성된 Character ID]`로 생성합니다. 기존 Lorebook 추가·병합 선택에는 API가 반환한 모든 종류의 Lorebook을 표시합니다.

Character와 Character Lorebook 연결은 공식 `POST /api/characters/:id/embedded-lorebook/embed` API를 사용합니다. 이 API가 Lorebook의 Character 링크와 Character Card V2 `character_book`을 동기화합니다. Engine schema상 카드에 연결할 수 없는 World·Persona 등 다른 종류의 기존 Lorebook은 Entry 저장만 진행하고 연결은 `해당 없음`으로 표시합니다. 신규 Entry가 여러 개면 bulk 생성 API를 우선하고, 기존 Entry 수정은 공식 Entry PATCH API를 사용합니다. Entry 생성 payload에는 Review의 `name`, `content`, `keys`, `secondaryKeys`, `constant`, `selective`만 전달하고 고급 insertion 필드는 Engine 기본값에 맡깁니다.

저장은 부분 성공을 허용합니다. 성공한 Character, Lorebook, Entry는 유지하며 기존 자산을 자동 삭제하거나 전체 rollback하지 않습니다. 실패 항목과 오류를 표시하고 같은 Review fingerprint 안에서는 성공 항목을 건너뛰어 실패 항목만 재시도합니다. 저장 완료 ID와 상태는 작업 session에 기록되며 같은 Review 상태의 중복 생성을 차단합니다. Review가 변경되면 이전 저장 결과임을 표시하고 다시 명시적으로 확인해야 저장할 수 있습니다.

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

는 각각 Import 시 선택한 **캐릭터 이름**과 **페르소나 이름**으로 자동 치환됩니다. 해당 항목을 선택하지 않으면 대응하는 플레이스홀더는 원문 그대로 유지됩니다.

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
- 대량 Import는 Marinara의 공개 단건 메시지 API를 순차 사용하되 요청 속도를 자동 조절합니다. API가 `429 Too many requests`와 `Retry-After`를 반환하면 해당 메시지부터 제한된 횟수만큼 대기 후 재시도하며, 실패한 채팅의 정리 요청도 같은 대기 규칙을 따릅니다.
- Import 후 Chats 목록에 새 채팅이 바로 표시되지 않으면 페이지를 새로고침하세요.
- 특수한 TXT 형식은 Import 전에 미리보기와 정리 결과를 확인하는 것을 권장합니다.

## Privacy

대화 파일을 가져오는 동작만으로 파일 내용이 외부 서비스에 전송되지는 않습니다. Prompt Conversion에서 대화 내역 참조를 ON으로 켜고 **대화 분석**을 명시적으로 실행하면 대화 가져오기 또는 선택한 채팅방의 범위와 원본 프롬프트가, 최종 **AI 분석**을 실행하면 원본 및 활성화된 대화 분석 기반 프롬프트가 사용자가 선택한 Marinara LLM Connection의 모델 제공자에게 전송될 수 있습니다.

확장 전용 마지막 작업 session에는 원본 프롬프트, 대화 분석 기반 프롬프트와 편집 중인 draft가 저장됩니다. Imported conversation 원문 전체, 선택 채팅방 메시지 원문, 중간 Chunk 추출 결과, 원본 AI 응답, 실행 중 run ID는 저장하지 않습니다. Imported conversation은 이름과 메시지 수만 참조 정보로 남기므로 Marinara 재실행 후 다시 분석하려면 파일을 다시 선택해야 합니다. 저장된 Chat-derived Prompt와 Review draft는 계속 편집할 수 있습니다.

이 확장은 Marinara의 채팅 및 메시지 기능에 접근하기 위해 `full_page_access` 권한을 사용합니다.
