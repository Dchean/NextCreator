# REQ-004 行为矩阵：改动前（HEAD）vs 候选（工作区）

- before 源码根: <LOCAL_USER_DIR>\AppData\Local\Temp\nc-abl-20260929190254
- candidate 源码根: D:\NextCreator
- 驱动层：nodeExecutor.executeNode（本次改动的那一层），provider/fileStorage 用同一组替身

| 场景 | before: result | candidate: result | before: node.status | candidate: node.status | 差异 |
|---|---|---|---|---|---|
| S1_success_no_canvas | success=true | success=true | "success" | "success" | 无 |
| S2_success_with_canvas_saveimage_fails | success=true | success=true | "success" | "success" | 无 |
| S3_empty_prompt | success=false err="缺少必需的提示词输入" | success=false err="请连接提示词节点" | "error" | "error" | **有** |
| S4_provider_error | success=false err="probe: provider error" | success=false err="probe: provider error" | "error" | "error" | 无 |
| S5_provider_no_image | success=true | success=false err="未返回图片数据" | "success" | "error" | **有** |
| S6_provider_throws | success=false err="probe: provider failure" | success=false err="probe: provider failure" | "error" | "error" | 无 |
| S7_preaborted_signal | success=false err="已取消" | success=false err="已取消" | "idle" | "idle" | 无 |
| S8_cancel_during_request | success=false err="已取消" | success=false err="已取消" | "idle" | "idle" | 无 |
| S9_cancel_during_save | success=true | success=false err="已取消" | "success" | "idle" | **有** |
| S9_cancel_during_save__saveWindowOpened | true | true | - | - | 无 |

共 10 个场景，其中 result 或 node.status 有差异的 3 个。

## 逐场景完整节点字段（只列有差异的场景）

### S1_success_no_canvas
```json
before    = {
  "result": {
    "success": true,
    "output": {
      "imageData": "data:image/png;base64,iVBORw0KGgo=",
      "imageDataList": [
        "data:image/png;base64,iVBORw0KGgo="
      ]
    }
  },
  "thrown": null,
  "node": {
    "status": "success",
    "error": null,
    "errorDetails": null,
    "outputImage": "data:image/png;base64,iVBORw0KGgo=",
    "outputImagePath": null,
    "outputImages": [
      "data:image/png;base64,iVBORw0KGgo="
    ],
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": null
  }
}
candidate = {
  "result": {
    "success": true,
    "output": {
      "imageData": "data:image/png;base64,iVBORw0KGgo=",
      "imageDataList": [
        "data:image/png;base64,iVBORw0KGgo="
      ]
    }
  },
  "thrown": null,
  "node": {
    "status": "success",
    "error": null,
    "errorDetails": null,
    "outputImage": "data:image/png;base64,iVBORw0KGgo=",
    "outputImagePath": null,
    "outputImages": [
      "data:image/png;base64,iVBORw0KGgo="
    ],
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": false
  }
}
```

### S2_success_with_canvas_saveimage_fails
```json
before    = {
  "result": {
    "success": true,
    "output": {
      "imageData": "data:image/png;base64,iVBORw0KGgo=",
      "imageDataList": [
        "data:image/png;base64,iVBORw0KGgo="
      ]
    }
  },
  "thrown": null,
  "node": {
    "status": "success",
    "error": null,
    "errorDetails": null,
    "outputImage": "data:image/png;base64,iVBORw0KGgo=",
    "outputImagePath": null,
    "outputImages": [
      "data:image/png;base64,iVBORw0KGgo="
    ],
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": null
  }
}
candidate = {
  "result": {
    "success": true,
    "output": {
      "imageData": "data:image/png;base64,iVBORw0KGgo=",
      "imageDataList": [
        "data:image/png;base64,iVBORw0KGgo="
      ]
    }
  },
  "thrown": null,
  "node": {
    "status": "success",
    "error": null,
    "errorDetails": null,
    "outputImage": "data:image/png;base64,iVBORw0KGgo=",
    "outputImagePath": null,
    "outputImages": [
      "data:image/png;base64,iVBORw0KGgo="
    ],
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": false
  }
}
```

### S3_empty_prompt
```json
before    = {
  "result": {
    "success": false,
    "error": "缺少必需的提示词输入"
  },
  "thrown": null,
  "node": {
    "status": "error",
    "error": "缺少必需的提示词输入",
    "errorDetails": null,
    "outputImage": null,
    "outputImagePath": null,
    "outputImages": null,
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": null
  }
}
candidate = {
  "result": {
    "success": false,
    "error": "请连接提示词节点"
  },
  "thrown": null,
  "node": {
    "status": "error",
    "error": "请连接提示词节点",
    "errorDetails": null,
    "outputImage": null,
    "outputImagePath": null,
    "outputImages": null,
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": false
  }
}
```

### S4_provider_error
```json
before    = {
  "result": {
    "success": false,
    "error": "probe: provider error"
  },
  "thrown": null,
  "node": {
    "status": "error",
    "error": "probe: provider error",
    "errorDetails": {
      "code": "E-PROBE"
    },
    "outputImage": null,
    "outputImagePath": null,
    "outputImages": null,
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": null
  }
}
candidate = {
  "result": {
    "success": false,
    "error": "probe: provider error"
  },
  "thrown": null,
  "node": {
    "status": "error",
    "error": "probe: provider error",
    "errorDetails": {
      "code": "E-PROBE"
    },
    "outputImage": null,
    "outputImagePath": null,
    "outputImages": null,
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": false
  }
}
```

### S5_provider_no_image
```json
before    = {
  "result": {
    "success": true,
    "output": {}
  },
  "thrown": null,
  "node": {
    "status": "success",
    "error": null,
    "errorDetails": null,
    "outputImage": null,
    "outputImagePath": null,
    "outputImages": null,
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": null
  }
}
candidate = {
  "result": {
    "success": false,
    "error": "未返回图片数据"
  },
  "thrown": null,
  "node": {
    "status": "error",
    "error": "未返回图片数据",
    "errorDetails": null,
    "outputImage": null,
    "outputImagePath": null,
    "outputImages": null,
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": false
  }
}
```

### S6_provider_throws
```json
before    = {
  "result": {
    "success": false,
    "error": "probe: provider failure"
  },
  "thrown": null,
  "node": {
    "status": "error",
    "error": "probe: provider failure",
    "errorDetails": null,
    "outputImage": null,
    "outputImagePath": null,
    "outputImages": null,
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": null
  }
}
candidate = {
  "result": {
    "success": false,
    "error": "probe: provider failure"
  },
  "thrown": null,
  "node": {
    "status": "error",
    "error": "probe: provider failure",
    "errorDetails": null,
    "outputImage": null,
    "outputImagePath": null,
    "outputImages": null,
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": false
  }
}
```

### S7_preaborted_signal
```json
before    = {
  "result": {
    "success": false,
    "error": "已取消"
  },
  "thrown": null,
  "node": {
    "status": "idle",
    "error": null,
    "errorDetails": null,
    "outputImage": null,
    "outputImagePath": null,
    "outputImages": null,
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": null
  }
}
candidate = {
  "result": {
    "success": false,
    "error": "已取消"
  },
  "thrown": null,
  "node": {
    "status": "idle",
    "error": null,
    "errorDetails": null,
    "outputImage": null,
    "outputImagePath": null,
    "outputImages": null,
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": false
  }
}
```

### S8_cancel_during_request
```json
before    = {
  "result": {
    "success": false,
    "error": "已取消"
  },
  "thrown": null,
  "node": {
    "status": "idle",
    "error": null,
    "errorDetails": null,
    "outputImage": null,
    "outputImagePath": null,
    "outputImages": null,
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": null
  }
}
candidate = {
  "result": {
    "success": false,
    "error": "已取消"
  },
  "thrown": null,
  "node": {
    "status": "idle",
    "error": null,
    "errorDetails": null,
    "outputImage": null,
    "outputImagePath": null,
    "outputImages": null,
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": false
  }
}
```

### S9_cancel_during_save
```json
before    = {
  "result": {
    "success": true,
    "output": {
      "imageData": "data:image/png;base64,iVBORw0KGgo=",
      "imageDataList": [
        "data:image/png;base64,iVBORw0KGgo="
      ]
    }
  },
  "thrown": null,
  "node": {
    "status": "success",
    "error": null,
    "errorDetails": null,
    "outputImage": "data:image/png;base64,iVBORw0KGgo=",
    "outputImagePath": null,
    "outputImages": [
      "data:image/png;base64,iVBORw0KGgo="
    ],
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": null
  }
}
candidate = {
  "result": {
    "success": false,
    "error": "已取消"
  },
  "thrown": null,
  "node": {
    "status": "idle",
    "error": null,
    "errorDetails": null,
    "outputImage": null,
    "outputImagePath": null,
    "outputImages": null,
    "outputImagePaths": null,
    "outputThumbPath": null,
    "outputThumbPaths": null,
    "runRecords": [],
    "queued": false
  }
}
```